import { Prisma, type StudyPlanTaskSource, type StudyPlanTaskType } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { badRequest, conflict, forbidden, notFound } from "../errors/api-error.js";
import { addLearnerDays, databaseDate, databaseDateKey, learnerDateKey } from "./learnerTime.js";
import { revisionIntervalDays } from "./trackerService.js";
import { getStudentConceptInsights } from "./studentPerformanceService.js";

const ALGORITHM_VERSION = "deterministic-plan-v2";
const FALLBACK_NOTE_MINUTES = 45;
const MIN_SESSION_MINUTES = 15;
const MAX_SESSION_MINUTES = 45;
const MAX_DAILY_TASKS = 5;

type Candidate = {
  type: StudyPlanTaskType;
  source: StudyPlanTaskSource;
  title: string;
  reason: string;
  contentItemId: string | null;
  estimatedMinutes: number;
  priority: number;
  estimateSource?: "ADMIN" | "FALLBACK_V1";
  carryTaskId?: string;
};

export function packStudyCandidates(candidates: Candidate[], availableMinutes: number, occupiedMinutes = 0, occupiedTasks = 0) {
  let remaining = Math.max(0, availableMinutes - occupiedMinutes);
  const slots = Math.max(0, MAX_DAILY_TASKS - occupiedTasks);
  const selected: Array<Candidate & { plannedMinutes: number }> = [];
  const contentIds = new Set<string>();
  for (const candidate of [...candidates].sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title))) {
    if (selected.length >= slots || remaining < MIN_SESSION_MINUTES) break;
    if (candidate.contentItemId && contentIds.has(candidate.contentItemId)) continue;
    const plannedMinutes = Math.min(MAX_SESSION_MINUTES, Math.max(MIN_SESSION_MINUTES, candidate.estimatedMinutes), remaining);
    if (plannedMinutes < MIN_SESSION_MINUTES) continue;
    selected.push({ ...candidate, plannedMinutes });
    if (candidate.contentItemId) contentIds.add(candidate.contentItemId);
    remaining -= plannedMinutes;
  }
  return selected;
}

async function learnerContext(userId: string) {
  const preference = await prisma.learnerPreference.findUnique({
    where: { userId },
    select: {
      timezone: true,
      dailyTargetMinutes: true,
      examDate: true,
      selectedCourse: { select: { id: true, code: true, name: true, status: true, deletedAt: true, academyId: true, academy: { select: { status: true, deletedAt: true } } } },
    },
  });
  const course = preference?.selectedCourse;
  if (!preference || !course || course.status !== "ACTIVE" || course.deletedAt || (course.academy && (course.academy.status !== "ACTIVE" || course.academy.deletedAt))) {
    throw conflict("COURSE_NOT_SELECTED", "Complete learner personalisation and select an active course first.");
  }
  if (course.academyId) {
    const membership = await prisma.academyMembership.findFirst({ where: { userId, academyId: course.academyId, role: "ACADEMY_STUDENT", status: "ACTIVE" }, select: { id: true } });
    if (!membership) throw forbidden("ACADEMY_MEMBERSHIP_REQUIRED", "This academy course is no longer available to your account.");
  }
  return { preference, course };
}

function validateDate(value: string, timezone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(databaseDate(value).getTime()) || databaseDateKey(databaseDate(value)) !== value) throw badRequest("INVALID_STUDY_PLAN_DATE", "Date must be a valid YYYY-MM-DD value.");
  const today = learnerDateKey(new Date(), timezone);
  if (value < addLearnerDays(today, -30) || value > addLearnerDays(today, 365)) throw badRequest("STUDY_PLAN_DATE_OUT_OF_RANGE", "Study-plan dates must be within the supported planning window.");
  return value;
}

async function accessibleContentIds(userId: string, courseId: string) {
  const now = new Date();
  const entitlements = await prisma.entitlement.findMany({
    where: { userId, status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { contentItemId: true, courseId: true, package: { select: { items: { select: { contentItemId: true } } } } },
    take: 2000,
  });
  const ids = new Set<string>();
  let courseAccess = false;
  for (const entitlement of entitlements) {
    if (entitlement.courseId === courseId) courseAccess = true;
    if (entitlement.contentItemId) ids.add(entitlement.contentItemId);
    for (const item of entitlement.package?.items ?? []) ids.add(item.contentItemId);
  }
  return { ids, courseAccess };
}

function examReason(examDate: Date | null, timezone: string) {
  if (!examDate) return "Next in your selected course sequence";
  const today = databaseDate(learnerDateKey(new Date(), timezone));
  const exam = databaseDate(learnerDateKey(examDate, timezone));
  const days = Math.max(0, Math.ceil((exam.getTime() - today.getTime()) / 86_400_000));
  return days === 0 ? "Exam-day priority from your selected course" : `Exam preparation · ${days} days remaining`;
}

async function buildCandidates(userId: string, courseId: string, localDate: string, timezone: string, examDate: Date | null) {
  const [items, states, access, carryTasks, estimates] = await Promise.all([
    prisma.contentItem.findMany({
      where: { courseId, kind: "FILE", mimeType: "application/pdf", status: "PUBLISHED", deletedAt: null },
      orderBy: [{ displayOrder: "asc" }, { name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, accessType: true, displayOrder: true },
      take: 5000,
    }),
    prisma.learnerNoteState.findMany({
      where: { userId, contentItem: { courseId, kind: "FILE", mimeType: "application/pdf", status: "PUBLISHED", deletedAt: null } },
      select: { contentItemId: true, completed: true, progressPercent: true, revisionCount: true, revisions: { orderBy: { revisedAt: "desc" }, take: 1, select: { revisedAt: true } } },
      take: 5000,
    }),
    accessibleContentIds(userId, courseId),
    prisma.learnerStudyTask.findMany({
      where: { userId, status: { in: ["PLANNED", "IN_PROGRESS"] }, hiddenAt: null, plan: { localDate: { lt: databaseDate(localDate) }, courseId } },
      orderBy: [{ plan: { localDate: "desc" } }, { priority: "desc" }, { sequence: "asc" }],
      select: { id: true, type: true, title: true, reason: true, contentItemId: true, plannedMinutes: true, priority: true, estimateSource: true },
      take: 20,
    }),
    prisma.studyWorkloadEstimate.findMany({ where: { contentItem: { courseId, status: "PUBLISHED", deletedAt: null } }, select: { contentItemId: true, estimatedReadingMinutes: true, estimatedRevisionMinutes: true }, take: 5000 }),
  ]);
  const stateById = new Map(states.map((state) => [state.contentItemId, state]));
  const estimateById = new Map(estimates.map((estimate) => [estimate.contentItemId, estimate]));
  const visibleItems = items.filter((item) => item.accessType === "FREE" || access.courseAccess || access.ids.has(item.id));
  const candidates: Candidate[] = carryTasks.map((task) => ({ type: task.type, source: "CARRY_OVER", title: task.title, reason: "Carried forward from an unfinished study plan", contentItemId: task.contentItemId, estimatedMinutes: task.plannedMinutes, priority: 100 + task.priority, estimateSource: task.estimateSource === "ADMIN" ? "ADMIN" : "FALLBACK_V1", carryTaskId: task.id }));

  const insights = await getStudentConceptInsights(userId, { courseId });
  for (const weak of insights.weakConcepts.slice(0, 2)) {
    candidates.push({ type: "PRACTICE_WEAK_CONCEPT", source: "WEAK_CONCEPT", title: `Strengthen ${weak.conceptName}`, reason: `${weak.wrong} incorrect answers across ${weak.attempts} attempts in ${weak.chapterName}`, contentItemId: null, estimatedMinutes: 25, priority: 95 - weak.accuracyPercent, estimateSource: "FALLBACK_V1" });
  }

  for (const item of visibleItems) {
    const state = stateById.get(item.id);
    const estimate = estimateById.get(item.id);
    const latestRevision = state?.revisions[0]?.revisedAt;
    const interval = revisionIntervalDays(state?.revisionCount ?? 0);
    if (interval && latestRevision && latestRevision.getTime() + interval * 86_400_000 <= Date.now()) {
      candidates.push({ type: "REVISE_NOTE", source: "REVISION_DUE", title: `Revise ${item.name}`, reason: `Revision due after ${interval} day${interval === 1 ? "" : "s"}`, contentItemId: item.id, estimatedMinutes: estimate?.estimatedRevisionMinutes ?? 25, priority: 90, estimateSource: estimate ? "ADMIN" : "FALLBACK_V1" });
    } else if (state && !state.completed && state.progressPercent > 0) {
      candidates.push({ type: "CONTINUE_NOTE", source: "CONTINUE_RESOURCE", title: `Continue ${item.name}`, reason: `${state.progressPercent}% read · continue from where you stopped`, contentItemId: item.id, estimatedMinutes: estimate ? Math.max(MIN_SESSION_MINUTES, Math.round(estimate.estimatedReadingMinutes * (1 - state.progressPercent / 100))) : 30, priority: 70, estimateSource: estimate ? "ADMIN" : "FALLBACK_V1" });
    } else if (!state?.completed) {
      candidates.push({ type: "READ_NOTE", source: "SYLLABUS_PLAN", title: `Study ${item.name}`, reason: examReason(examDate, timezone), contentItemId: item.id, estimatedMinutes: estimate?.estimatedReadingMinutes ?? FALLBACK_NOTE_MINUTES, priority: 50 - Math.min(item.displayOrder, 40), estimateSource: estimate ? "ADMIN" : "FALLBACK_V1" });
    }
  }
  return candidates;
}

const taskSelect = {
  id: true, type: true, source: true, status: true, estimateSource: true, title: true, reason: true, plannedMinutes: true, actualMinutes: true, priority: true, sequence: true, contentItemId: true, startedAt: true, completedAt: true, skippedAt: true, rescheduledForDate: true, createdAt: true, updatedAt: true,
} satisfies Prisma.LearnerStudyTaskSelect;

async function presentPlan(planId: string) {
  const plan = await prisma.learnerStudyPlan.findUniqueOrThrow({
    where: { id: planId },
    select: { id: true, localDate: true, timezone: true, availableMinutes: true, algorithmVersion: true, generation: true, generatedAt: true, course: { select: { id: true, code: true, name: true } }, tasks: { where: { hiddenAt: null, status: { not: "REPLACED" } }, orderBy: [{ sequence: "asc" }, { createdAt: "asc" }], select: taskSelect } },
  });
  const completed = plan.tasks.filter((task) => task.status === "COMPLETED").length;
  return { ...plan, localDate: databaseDateKey(plan.localDate), summary: { completed, total: plan.tasks.length, plannedMinutes: plan.tasks.filter((task) => !["SKIPPED", "RESCHEDULED"].includes(task.status)).reduce((sum, task) => sum + task.plannedMinutes, 0), completedMinutes: plan.tasks.filter((task) => task.status === "COMPLETED").reduce((sum, task) => sum + (task.actualMinutes ?? task.plannedMinutes), 0) } };
}

async function generateStudyPlanOnce(userId: string, requestedDate?: string, regenerate = false) {
  const { preference, course } = await learnerContext(userId);
  const localDate = validateDate(requestedDate ?? learnerDateKey(new Date(), preference.timezone), preference.timezone);
  const stored = await prisma.learnerStudyPlan.findUnique({ where: { userId_localDate: { userId, localDate: databaseDate(localDate) } }, select: { id: true, courseId: true } });
  if (stored && stored.courseId === course.id && !regenerate) return presentPlan(stored.id);

  const candidates = await buildCandidates(userId, course.id, localDate, preference.timezone, preference.examDate);
  const planId = await prisma.$transaction(async (tx) => {
    const plan = await tx.learnerStudyPlan.upsert({
      where: { userId_localDate: { userId, localDate: databaseDate(localDate) } },
      create: { userId, courseId: course.id, localDate: databaseDate(localDate), timezone: preference.timezone, availableMinutes: preference.dailyTargetMinutes, algorithmVersion: ALGORITHM_VERSION },
      update: { courseId: course.id, timezone: preference.timezone, availableMinutes: preference.dailyTargetMinutes, algorithmVersion: ALGORITHM_VERSION, generation: { increment: 1 }, generatedAt: new Date() },
      select: { id: true },
    });
    if (stored) await tx.learnerStudyTask.updateMany({ where: { planId: plan.id, source: { not: "MANUAL" }, status: "PLANNED" }, data: { status: "REPLACED", hiddenAt: new Date() } });
    const preserved = await tx.learnerStudyTask.findMany({ where: { planId: plan.id, OR: [{ hiddenAt: null, status: { in: ["PLANNED", "IN_PROGRESS", "COMPLETED"] } }, { status: "COMPLETED" }] }, select: { plannedMinutes: true, contentItemId: true } });
    const preservedContent = new Set(preserved.map((task) => task.contentItemId).filter(Boolean));
    const selected = packStudyCandidates(candidates.filter((candidate) => !candidate.contentItemId || !preservedContent.has(candidate.contentItemId)), preference.dailyTargetMinutes, preserved.reduce((sum, task) => sum + task.plannedMinutes, 0), preserved.length);
    if (selected.length) {
      await tx.learnerStudyTask.createMany({ data: selected.map((task, index) => ({ planId: plan.id, userId, contentItemId: task.contentItemId, type: task.type, source: task.source, estimateSource: task.estimateSource ?? "FALLBACK_V1", title: task.title, reason: task.reason, plannedMinutes: task.plannedMinutes, priority: task.priority, sequence: preserved.length + index + 1 })) });
      const carryIds = selected.map((task) => task.carryTaskId).filter((id): id is string => Boolean(id));
      if (carryIds.length) await tx.learnerStudyTask.updateMany({ where: { userId, id: { in: carryIds }, status: { in: ["PLANNED", "IN_PROGRESS"] } }, data: { status: "RESCHEDULED", rescheduledForDate: databaseDate(localDate) } });
    }
    return plan.id;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return presentPlan(planId);
}

export async function generateStudyPlan(userId: string, requestedDate?: string, regenerate = false) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await generateStudyPlanOnce(userId, requestedDate, regenerate); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034") && attempt < 2) continue;
      throw error;
    }
  }
  throw conflict("STUDY_PLAN_GENERATION_CONFLICT", "The study plan is being updated. Please try again.");
}

export async function getTodayStudyPlan(userId: string, requestedDate?: string) {
  return generateStudyPlan(userId, requestedDate, false);
}

export async function addManualTask(userId: string, input: { title: string; plannedMinutes: number; date?: string }) {
  const plan = await generateStudyPlan(userId, input.date, false);
  const sequence = Math.max(0, ...plan.tasks.map((task) => task.sequence)) + 1;
  await prisma.learnerStudyTask.create({ data: { planId: plan.id, userId, type: "MANUAL", source: "MANUAL", estimateSource: "LEARNER", title: input.title, reason: "Added by you", plannedMinutes: input.plannedMinutes, priority: 40, sequence } });
  return presentPlan(plan.id);
}

async function ownedTask(userId: string, taskId: string) {
  const task = await prisma.learnerStudyTask.findFirst({ where: { id: taskId, userId }, select: { ...taskSelect, planId: true, plan: { select: { localDate: true, timezone: true, courseId: true, availableMinutes: true, algorithmVersion: true } } } });
  if (!task) throw notFound("STUDY_TASK_NOT_FOUND", "The study task was not found.");
  return task;
}

export async function updateStudyTask(userId: string, taskId: string, input: { action: "start" | "complete" | "reopen" | "skip" | "reschedule"; actualMinutes?: number; date?: string }) {
  const task = await ownedTask(userId, taskId);
  const now = new Date();
  if (input.action === "reschedule") {
    if (!input.date) throw badRequest("RESCHEDULE_DATE_REQUIRED", "Choose a date for the rescheduled task.");
    const date = validateDate(input.date, task.plan.timezone);
    if (date <= databaseDateKey(task.plan.localDate)) throw badRequest("RESCHEDULE_DATE_INVALID", "Choose a future date for the rescheduled task.");
    if (task.status === "RESCHEDULED" && task.rescheduledForDate && databaseDateKey(task.rescheduledForDate) === date) return presentPlan(task.planId);
    if (task.status === "COMPLETED") throw conflict("STUDY_TASK_ALREADY_COMPLETED", "A completed task cannot be rescheduled.");
    await prisma.$transaction(async (tx) => {
      const targetPlan = await tx.learnerStudyPlan.upsert({ where: { userId_localDate: { userId, localDate: databaseDate(date) } }, create: { userId, courseId: task.plan.courseId, localDate: databaseDate(date), timezone: task.plan.timezone, availableMinutes: task.plan.availableMinutes, algorithmVersion: task.plan.algorithmVersion }, update: {}, select: { id: true } });
      const last = await tx.learnerStudyTask.aggregate({ where: { planId: targetPlan.id }, _max: { sequence: true } });
      await tx.learnerStudyTask.create({ data: { planId: targetPlan.id, userId, contentItemId: task.contentItemId, type: task.type, source: "CARRY_OVER", estimateSource: task.estimateSource, title: task.title, reason: `Rescheduled from ${databaseDateKey(task.plan.localDate)}`, plannedMinutes: task.plannedMinutes, priority: task.priority, sequence: (last._max.sequence ?? 0) + 1 } });
      await tx.learnerStudyTask.update({ where: { id: task.id }, data: { status: "RESCHEDULED", rescheduledForDate: databaseDate(date) } });
    });
    return presentPlan(task.planId);
  }
  if (input.action === "complete" && task.status === "COMPLETED") return presentPlan(task.planId);
  if (input.action === "reopen" && task.status !== "COMPLETED") return presentPlan(task.planId);
  if (["SKIPPED", "RESCHEDULED", "REPLACED"].includes(task.status) && input.action !== "reopen") throw conflict("STUDY_TASK_NOT_ACTIONABLE", "This study task is no longer actionable.");
  const data: Prisma.LearnerStudyTaskUpdateInput = input.action === "start"
    ? { status: "IN_PROGRESS", startedAt: task.startedAt ?? now }
    : input.action === "complete"
      ? { status: "COMPLETED", completedAt: now, actualMinutes: input.actualMinutes ?? task.plannedMinutes }
      : input.action === "reopen"
        ? { status: "PLANNED", completedAt: null, actualMinutes: null }
        : { status: "SKIPPED", skippedAt: now };
  await prisma.learnerStudyTask.update({ where: { id: task.id }, data });
  return presentPlan(task.planId);
}

export async function hideStudyTask(userId: string, taskId: string) {
  const task = await ownedTask(userId, taskId);
  await prisma.learnerStudyTask.update({ where: { id: task.id }, data: { hiddenAt: new Date(), ...(task.status === "PLANNED" ? { status: "SKIPPED", skippedAt: new Date() } : {}) } });
  return presentPlan(task.planId);
}

export async function clearCompletedTasks(userId: string, date?: string) {
  const { preference } = await learnerContext(userId);
  const localDate = validateDate(date ?? learnerDateKey(new Date(), preference.timezone), preference.timezone);
  const plan = await prisma.learnerStudyPlan.findUnique({ where: { userId_localDate: { userId, localDate: databaseDate(localDate) } }, select: { id: true } });
  if (!plan) return generateStudyPlan(userId, localDate, false);
  await prisma.learnerStudyTask.updateMany({ where: { planId: plan.id, userId, status: "COMPLETED", hiddenAt: null }, data: { hiddenAt: new Date() } });
  return presentPlan(plan.id);
}
