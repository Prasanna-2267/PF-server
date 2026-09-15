import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { conflict, forbidden } from "../errors/api-error.js";
import { addLearnerDays, databaseDate, databaseDateKey, learnerDateKey } from "./learnerTime.js";
import { ALLOWED_CONTENT_MIME_TYPES } from "../utils/upload-validation.js";

type RevisionFilter = "all" | "due" | "not_started";

const publishedNoteWhere = (courseId: string): Prisma.ContentItemWhereInput => ({
  courseId,
  kind: "FILE",
  mimeType: { in: [...ALLOWED_CONTENT_MIME_TYPES] },
  status: "PUBLISHED",
  deletedAt: null,
  OR: [{ entityType: null }, { entityType: { not: "MONTHLY_REPORT" } }],
});

export function calculateExamCountdown(examDate: Date | null, todayKey: string) {
  if (!examDate) return { dateKey: null, daysRemaining: null, pressurePercent: null };
  // examDate is a calendar date stored at UTC midnight. Passing it through a
  // timezone conversion can move it to an adjacent day, so compare date-only
  // UTC values with the learner's already-normalized today key.
  const dateKey = databaseDateKey(examDate);
  const difference = Math.round((databaseDate(dateKey).getTime() - databaseDate(todayKey).getTime()) / 86_400_000);
  const daysRemaining = Math.max(0, difference);
  const pressurePercent = Math.max(0, Math.min(100, Math.round(100 - (Math.min(daysRemaining, 365) / 365) * 100)));
  return { dateKey, daysRemaining, pressurePercent };
}

async function learnerContext(userId: string) {
  const preference = await prisma.learnerPreference.findUnique({
    where: { userId },
    select: {
      timezone: true,
      dailyTargetMinutes: true,
      examDate: true,
      examDatePrecision: true,
      selectedCourse: {
        select: {
          id: true,
          code: true,
          name: true,
          status: true,
          deletedAt: true,
          academyId: true,
          academy: { select: { id: true, status: true, deletedAt: true } },
        },
      },
    },
  });
  const course = preference?.selectedCourse;
  if (!preference || !course || course.status !== "ACTIVE" || course.deletedAt || (course.academy && (course.academy.status !== "ACTIVE" || course.academy.deletedAt))) {
    throw conflict("COURSE_NOT_SELECTED", "Complete learner personalisation and select an active course first.");
  }
  if (course.academyId) {
    const membership = await prisma.academyMembership.findFirst({
      where: { userId, academyId: course.academyId, role: "ACADEMY_STUDENT", status: "ACTIVE" },
      select: { id: true },
    });
    if (!membership) throw forbidden("ACADEMY_MEMBERSHIP_REQUIRED", "This academy course is no longer available to your account.");
  }
  return { preference, course };
}

function activitySeconds(activity: { focusSeconds: number; readingSeconds: number; practiceSeconds: number; revisionSeconds: number }) {
  return activity.focusSeconds + activity.readingSeconds + activity.practiceSeconds + activity.revisionSeconds;
}

export function revisionIntervalDays(revisionCount: number) {
  if (revisionCount <= 0) return null;
  if (revisionCount === 1) return 1;
  if (revisionCount === 2) return 7;
  return 21;
}

function addUtcDays(value: Date, days: number) {
  return new Date(value.getTime() + days * 86_400_000);
}

export async function getTrackerSummary(userId: string, days: 7 | 30 | 90) {
  const now = new Date();
  const { preference, course } = await learnerContext(userId);
  const today = learnerDateKey(now, preference.timezone);
  const firstDate = addLearnerDays(today, -(days - 1));
  const previousFirstDate = addLearnerDays(firstDate, -days);

  const [activity, previousActivity, streak, noteCount, noteTotals] = await Promise.all([
    prisma.learnerDailyActivity.findMany({
      where: { userId, localDate: { gte: databaseDate(firstDate), lte: databaseDate(today) } },
      orderBy: { localDate: "asc" },
    }),
    prisma.learnerDailyActivity.findMany({
      where: { userId, localDate: { gte: databaseDate(previousFirstDate), lt: databaseDate(firstDate) } },
      select: { focusSeconds: true, readingSeconds: true, practiceSeconds: true, revisionSeconds: true },
    }),
    prisma.learnerStreakState.findUnique({ where: { userId }, select: { currentStreak: true, longestStreak: true, lastQualifiedDate: true } }),
    prisma.contentItem.count({ where: publishedNoteWhere(course.id) }),
    prisma.learnerNoteState.aggregate({
      where: { userId, contentItem: publishedNoteWhere(course.id) },
      _count: { _all: true, completed: true },
      _sum: { revisionCount: true },
    }),
  ]);

  const activityByDate = new Map(activity.map((entry) => [databaseDateKey(entry.localDate), entry]));
  const consistency = Array.from({ length: days }, (_, index) => {
    const date = addLearnerDays(firstDate, index);
    const entry = activityByDate.get(date);
    const targetMinutes = entry?.targetMinutes ?? preference.dailyTargetMinutes;
    const totalSeconds = entry ? activitySeconds(entry) : 0;
    return {
      date,
      totalSeconds,
      focusSeconds: entry?.focusSeconds ?? 0,
      readingSeconds: entry?.readingSeconds ?? 0,
      practiceSeconds: entry?.practiceSeconds ?? 0,
      revisionSeconds: entry?.revisionSeconds ?? 0,
      targetMinutes,
      goalCompleted: totalSeconds >= targetMinutes * 60,
      active: totalSeconds > 0,
    };
  });
  const totalSeconds = consistency.reduce((sum, entry) => sum + entry.totalSeconds, 0);
  const previousSeconds = previousActivity.reduce((sum, entry) => sum + activitySeconds(entry), 0);
  const changePercent = previousSeconds > 0 ? Math.round(((totalSeconds - previousSeconds) / previousSeconds) * 100) : totalSeconds > 0 ? 100 : 0;
  const bestDay = consistency.reduce<(typeof consistency)[number] | null>((best, entry) => !best || entry.totalSeconds > best.totalSeconds ? entry : best, null);
  const completedNotes = await prisma.learnerNoteState.count({ where: { userId, completed: true, contentItem: publishedNoteWhere(course.id) } });
  const examDate = preference.examDate;
  const exam = calculateExamCountdown(examDate, today);

  return {
    range: { days, from: firstDate, to: today, timezone: preference.timezone },
    course: { id: course.id, code: course.code, name: course.name },
    consistency,
    summary: {
      totalSeconds,
      dailyAverageSeconds: Math.round(totalSeconds / days),
      activeDays: consistency.filter((entry) => entry.active).length,
      goalDays: consistency.filter((entry) => entry.goalCompleted).length,
      bestDay: bestDay && bestDay.totalSeconds > 0 ? { date: bestDay.date, totalSeconds: bestDay.totalSeconds } : null,
      changePercent,
    },
    streak: {
      current: streak?.currentStreak ?? 0,
      longest: streak?.longestStreak ?? 0,
      lastQualifiedDate: streak?.lastQualifiedDate ? databaseDateKey(streak.lastQualifiedDate) : null,
    },
    readiness: {
      totalNotes: noteCount,
      completedNotes,
      syllabusPercent: noteCount ? Math.round((completedNotes / noteCount) * 100) : 0,
      revisions: noteTotals._sum.revisionCount ?? 0,
      notesWithActivity: noteTotals._count._all,
    },
    exam: {
      date: exam.dateKey,
      precision: preference.examDatePrecision,
      daysRemaining: exam.daysRemaining,
      pressurePercent: exam.pressurePercent,
    },
    serverTime: now,
  };
}

type ContentNode = {
  id: string;
  parentId: string | null;
  kind: "FOLDER" | "FILE";
  name: string;
  entityType: string | null;
  displayOrder: number;
};

function ancestry(item: ContentNode, folders: Map<string, ContentNode>) {
  const result: ContentNode[] = [];
  const visited = new Set<string>();
  let parentId = item.parentId;
  while (parentId && result.length < 12 && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = folders.get(parentId);
    if (!parent) break;
    result.unshift(parent);
    parentId = parent.parentId;
  }
  return result;
}

export async function getRevisionChapters(userId: string, input: { filter: RevisionFilter; subjectId?: string }) {
  const now = new Date();
  const { preference, course } = await learnerContext(userId);
  const [items, states] = await Promise.all([
    prisma.contentItem.findMany({
      where: { courseId: course.id, status: "PUBLISHED", deletedAt: null, OR: [{ kind: "FOLDER" }, { kind: "FILE", mimeType: { in: [...ALLOWED_CONTENT_MIME_TYPES] } }] },
      orderBy: [{ displayOrder: "asc" }, { name: "asc" }, { id: "asc" }],
      select: { id: true, parentId: true, kind: true, name: true, entityType: true, displayOrder: true },
      take: 5000,
    }),
    prisma.learnerNoteState.findMany({
      where: { userId, contentItem: publishedNoteWhere(course.id) },
      select: {
        contentItemId: true,
        completed: true,
        revisionCount: true,
        revisions: { orderBy: { revisedAt: "desc" }, take: 1, select: { revisedAt: true } },
      },
      take: 5000,
    }),
  ]);
  const folders = new Map(items.filter((item) => item.kind === "FOLDER").map((item) => [item.id, item as ContentNode]));
  const stateByNote = new Map(states.map((state) => [state.contentItemId, state]));
  const groups = new Map<string, {
    id: string;
    title: string;
    order: number;
    subject: { id: string; title: string };
    notes: Array<{ id: string; completed: boolean; revisionCount: number; lastRevisedAt: Date | null }>;
  }>();

  for (const item of items) {
    if (item.kind !== "FILE") continue;
    const parents = ancestry(item as ContentNode, folders);
    const subject = [...parents].reverse().find((parent) => parent.entityType === "SUBJECT") ?? parents[0];
    const chapter = [...parents].reverse().find((parent) => parent.entityType === "CHAPTER") ?? parents.at(-1) ?? subject;
    const subjectValue = subject ? { id: subject.id, title: subject.name } : { id: course.id, title: course.name };
    const chapterId = chapter?.id ?? `course-${course.id}`;
    if (input.subjectId && subjectValue.id !== input.subjectId) continue;
    const group = groups.get(chapterId) ?? { id: chapterId, title: chapter?.name ?? "Course materials", order: chapter?.displayOrder ?? 0, subject: subjectValue, notes: [] };
    const state = stateByNote.get(item.id);
    group.notes.push({ id: item.id, completed: state?.completed ?? false, revisionCount: state?.revisionCount ?? 0, lastRevisedAt: state?.revisions[0]?.revisedAt ?? null });
    groups.set(chapterId, group);
  }

  const chapters = [...groups.values()].map((group) => {
    const revisionCount = group.notes.reduce((sum, note) => sum + note.revisionCount, 0);
    const completedNotes = group.notes.filter((note) => note.completed).length;
    const revisedNotes = group.notes.filter((note) => note.revisionCount > 0).length;
    const revisionDepthPercent = Math.round((group.notes.reduce((sum, note) => sum + Math.min(3, note.revisionCount), 0) / Math.max(1, group.notes.length * 3)) * 100);
    const lastRevisedAt = group.notes.reduce<Date | null>((latest, note) => !note.lastRevisedAt ? latest : !latest || note.lastRevisedAt > latest ? note.lastRevisedAt : latest, null);
    const dueDates = group.notes.flatMap((note) => {
      const interval = revisionIntervalDays(note.revisionCount);
      return interval && note.lastRevisedAt ? [addUtcDays(note.lastRevisedAt, interval)] : [];
    });
    const nextDueAt = dueDates.length ? new Date(Math.min(...dueDates.map((date) => date.getTime()))) : null;
    const status = revisionCount === 0 ? "not_started" as const : nextDueAt && nextDueAt <= now ? "due" as const : revisionDepthPercent >= 100 ? "in_rhythm" as const : "upcoming" as const;
    return { id: group.id, title: group.title, subject: group.subject, totalNotes: group.notes.length, completedNotes, revisedNotes, revisionCount, revisionDepthPercent, status, lastRevisedAt, nextDueAt, order: group.order };
  }).filter((chapter) => input.filter === "all" || (input.filter === "due" ? chapter.status === "due" : chapter.status === "not_started"))
    .sort((a, b) => a.subject.title.localeCompare(b.subject.title) || a.order - b.order || a.title.localeCompare(b.title));

  const allChapters = [...groups.values()];
  const totalRevisions = states.reduce((sum, state) => sum + state.revisionCount, 0);
  const revisedChapterIds = new Set(states.filter((state) => state.revisionCount > 0).map((state) => {
    const item = items.find((candidate) => candidate.id === state.contentItemId);
    const parents = item ? ancestry(item as ContentNode, folders) : [];
    return ([...parents].reverse().find((parent) => parent.entityType === "CHAPTER") ?? parents.at(-1))?.id;
  }).filter(Boolean));

  return {
    course: { id: course.id, code: course.code, name: course.name },
    timezone: preference.timezone,
    summary: { totalRevisions, totalChapters: allChapters.length, revisedChapters: revisedChapterIds.size, returnedNotes: states.filter((state) => state.revisionCount > 0).length },
    chapters,
    serverTime: now,
  };
}

export async function getRevisionHistory(userId: string, input: { page: number; limit: number }) {
  const { course } = await learnerContext(userId);
  const where: Prisma.NoteRevisionEventWhereInput = { userId, noteState: { contentItem: publishedNoteWhere(course.id) } };
  const [events, total] = await Promise.all([
    prisma.noteRevisionEvent.findMany({
      where,
      orderBy: [{ revisedAt: "desc" }, { id: "desc" }],
      skip: (input.page - 1) * input.limit,
      take: input.limit,
      select: { id: true, source: true, revisedAt: true, contentItemId: true, noteState: { select: { contentItem: { select: { name: true, parentId: true } } } } },
    }),
    prisma.noteRevisionEvent.count({ where }),
  ]);
  return {
    items: events.map((event) => ({ id: event.id, noteId: event.contentItemId, noteTitle: event.noteState.contentItem.name, source: event.source, revisedAt: event.revisedAt })),
    pagination: { page: input.page, limit: input.limit, total, pages: Math.ceil(total / input.limit) },
  };
}
