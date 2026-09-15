import { createHash } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { badRequest, conflict, forbidden, notFound, serviceUnavailable } from "../errors/api-error.js";
import { getStorageProvider } from "../integrations/provider-registry.js";
import { getConfig } from "../config/env.js";
import { databaseDate, databaseDateKey, learnerDateKey, learnerDayStartInstant, monthBounds } from "./learnerTime.js";
import { enqueueJob } from "./backgroundJobService.js";
import { createLearnerNotification } from "./learnerNotificationService.js";
import { generateMonthlyReportPdf } from "./monthlyReportPdfService.js";
import type { MonthlyReportSnapshot, ReportDelta } from "./monthlyReportTypes.js";
import { MONTHLY_REPORT_EMAIL_JOB } from "./monthlyReportEmailService.js";
import { ALLOWED_CONTENT_MIME_TYPES } from "../utils/upload-validation.js";

export const MONTHLY_REPORT_JOB = "MONTHLY_REPORT_GENERATE";
const ALGORITHM_VERSION = "monthly-report-v3";
const REPORT_PRICE = new Prisma.Decimal("99.00");
const MAX_ARCHIVE_MONTHS = 60;

type Db = Prisma.TransactionClient | typeof prisma;
type ActivityRow = { localDate: Date; focusSeconds: number; readingSeconds: number; practiceSeconds: number; revisionSeconds: number; goalCompleted: boolean };

const reportContentWhere = (courseId: string): Prisma.ContentItemWhereInput => ({
  courseId,
  kind: "FILE",
  status: "PUBLISHED",
  deletedAt: null,
  mimeType: { in: [...ALLOWED_CONTENT_MIME_TYPES] },
  OR: [{ entityType: null }, { entityType: { not: "MONTHLY_REPORT" } }],
});

export function summarizeMonthlyActivity(rows: ActivityRow[]) {
  const weeklyStudySeconds = [0, 0, 0, 0, 0];
  let focusSeconds = 0; let readingSeconds = 0; let practiceSeconds = 0; let revisionSeconds = 0; let goalDays = 0; let activeDays = 0;
  for (const row of rows) {
    const total = row.focusSeconds + row.readingSeconds + row.practiceSeconds + row.revisionSeconds;
    weeklyStudySeconds[Math.min(4, Math.floor((row.localDate.getUTCDate() - 1) / 7))] += total;
    focusSeconds += row.focusSeconds; readingSeconds += row.readingSeconds; practiceSeconds += row.practiceSeconds; revisionSeconds += row.revisionSeconds;
    if (total > 0) activeDays += 1;
    if (row.goalCompleted) goalDays += 1;
  }
  return { totalStudySeconds: focusSeconds + readingSeconds + practiceSeconds + revisionSeconds, focusSeconds, readingSeconds, practiceSeconds, revisionSeconds, activeDays, goalDays, weeklyStudySeconds };
}

function shiftMonth(yearMonth: string, amount: number) {
  const date = databaseDate(`${yearMonth}-01`);
  date.setUTCMonth(date.getUTCMonth() + amount);
  return databaseDateKey(date).slice(0, 7);
}

export function monthlyReportSchedule(purchasedAt: Date, timezone: string) {
  const yearMonth = learnerDateKey(purchasedAt, timezone).slice(0, 7);
  const nextMonth = shiftMonth(yearMonth, 1);
  const { start, end } = monthBounds(yearMonth);
  return { yearMonth, start, end, runAt: learnerDayStartInstant(`${nextMonth}-01`, timezone) };
}

const monthLabel = (yearMonth: string) => new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }).format(databaseDate(`${yearMonth}-01`));
const round = (value: number, digits = 1) => Number(value.toFixed(digits));
const percent = (part: number, total: number) => total ? round(part / total * 100, 1) : null;
const inLearnerMonth = (date: Date | null, yearMonth: string, timezone: string) => Boolean(date && learnerDateKey(date, timezone).startsWith(`${yearMonth}-`));
const delta = (current: number, previous: number, unit: ReportDelta["unit"]): ReportDelta => ({ value: round(current - previous, unit === "HOURS" ? 1 : 1), unit, direction: current > previous ? "UP" : current < previous ? "DOWN" : "SAME" });
const safeJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

async function learnerContext(userId: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, status: "ACTIVE", deletedAt: null },
    select: { id: true, fullName: true, learnerPreference: { select: { timezone: true, dailyTargetMinutes: true, selectedCourse: { select: { id: true, code: true, name: true, status: true, deletedAt: true } } } } },
  });
  const preference = user?.learnerPreference;
  if (!user || !preference?.selectedCourse || preference.selectedCourse.status !== "ACTIVE" || preference.selectedCourse.deletedAt) {
    throw conflict("COURSE_NOT_SELECTED", "Complete learner personalisation and select an active course first.");
  }
  return { userId, fullName: user.fullName, timezone: preference.timezone || "Asia/Kolkata", dailyTargetMinutes: preference.dailyTargetMinutes, course: preference.selectedCourse };
}

async function reportContext(userId: string, courseId: string) {
  const [user, course] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId, status: "ACTIVE", deletedAt: null }, select: { id: true, fullName: true, learnerPreference: { select: { timezone: true, dailyTargetMinutes: true } } } }),
    prisma.course.findFirst({ where: { id: courseId, status: "ACTIVE", deletedAt: null }, select: { id: true, code: true, name: true } }),
  ]);
  if (!user || !course) throw notFound("MONTHLY_REPORT_CONTEXT_NOT_FOUND", "The learner or purchased report course is no longer available.");
  return { userId, fullName: user.fullName, timezone: user.learnerPreference?.timezone || "Asia/Kolkata", dailyTargetMinutes: user.learnerPreference?.dailyTargetMinutes ?? 30, course };
}

export async function ensureMonthlyReportProduct(courseId: string, db: Db = prisma) {
  const course = await db.course.findFirst({ where: { id: courseId, status: "ACTIVE", deletedAt: null }, select: { id: true, name: true } });
  if (!course) throw notFound("COURSE_NOT_FOUND", "The active course was not found.");
  const existing = await db.contentItem.findFirst({ where: { courseId, entityType: "MONTHLY_REPORT", status: "PUBLISHED", deletedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  if (existing) return existing;
  try {
    return await db.contentItem.create({ data: {
      courseId,
      // This is a purchasable catalogue capability, not an uploaded binary.
      // FOLDER is the existing storage-less ContentItem representation and
      // satisfies ContentItem_kind_storage_check without inventing a file key.
      kind: "FOLDER",
      name: `${course.name} Monthly Report`,
      description: "A professionally generated monthly learning report with practice performance, study consistency, concept progress, strengths and weak areas.",
      entityType: "MONTHLY_REPORT",
      accessType: "PAID",
      price: REPORT_PRICE,
      status: "PUBLISHED",
      size: 0,
      displayOrder: 9_900,
    } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return db.contentItem.findFirstOrThrow({ where: { courseId, entityType: "MONTHLY_REPORT", status: "PUBLISHED", deletedAt: null } });
    }
    throw error;
  }
}

async function reportEntitlement(userId: string, productId: string) {
  const now = new Date();
  return prisma.entitlement.findFirst({
    where: { userId, contentItemId: productId, resourceType: "MONTHLY_REPORT", status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    orderBy: [{ grantedAt: "asc" }, { id: "asc" }],
  });
}

function productView(product: Awaited<ReturnType<typeof ensureMonthlyReportProduct>>) {
  return { id: product.id, name: product.name, description: product.description, price: Number(product.price ?? REPORT_PRICE), currency: "INR", storePath: `/store/product/${product.id}?type=notes` };
}

function completedMonths(from: Date, timezone: string) {
  const current = learnerDateKey(new Date(), timezone).slice(0, 7);
  const first = learnerDateKey(from, timezone).slice(0, 7);
  const values: string[] = [];
  for (let value = shiftMonth(current, -1); value >= first && values.length < MAX_ARCHIVE_MONTHS; value = shiftMonth(value, -1)) values.push(value);
  return values;
}

function reportListItem(report: { id: string; yearMonth: string; timezone: string; status: string; generatedAt: Date | null; updatedAt: Date; version: number; failureCode: string | null; pdfSizeBytes: bigint | null }) {
  const scheduledFor = learnerDayStartInstant(`${shiftMonth(report.yearMonth, 1)}-01`, report.timezone);
  return { id: report.id, yearMonth: report.yearMonth, label: monthLabel(report.yearMonth), status: report.status, scheduledFor, isScheduled: report.status === "PENDING" && scheduledFor > new Date(), generatedAt: report.generatedAt, updatedAt: report.updatedAt, version: report.version, failureCode: report.failureCode, sizeBytes: report.pdfSizeBytes ? Number(report.pdfSizeBytes) : null, canView: report.status === "READY" };
}

export async function listMonthlyReports(userId: string) {
  const context = await learnerContext(userId);
  const product = await ensureMonthlyReportProduct(context.course.id);
  const entitlement = await reportEntitlement(userId, product.id);
  if (!entitlement) return { access: { owned: false, product: productView(product) }, items: [], serverTime: new Date() };
  const reports = await prisma.learnerMonthlyReport.findMany({ where: { userId, courseId: context.course.id, productContentItemId: product.id }, orderBy: [{ periodStart: "desc" }, { id: "desc" }], take: MAX_ARCHIVE_MONTHS });
  return { access: { owned: true, entitlementId: entitlement.id, grantedAt: entitlement.grantedAt, expiresAt: entitlement.expiresAt, product: productView(product) }, items: reports.map(reportListItem), serverTime: new Date() };
}

export async function getMonthlyReport(userId: string, yearMonth: string) {
  const context = await learnerContext(userId);
  const product = await ensureMonthlyReportProduct(context.course.id);
  const entitlement = await reportEntitlement(userId, product.id);
  if (!entitlement) throw forbidden("MONTHLY_REPORT_NOT_PURCHASED", "Purchase Monthly Report in the Store to access this report.");
  const report = await prisma.learnerMonthlyReport.findFirst({ where: { userId, yearMonth, courseId: context.course.id, productContentItemId: product.id } });
  if (!report) throw notFound("MONTHLY_REPORT_NOT_FOUND", "This completed-month report is not available.");
  return { ...reportListItem(report), course: { id: context.course.id, code: context.course.code, name: context.course.name }, hasSnapshot: Boolean(report.snapshotJson) };
}

export async function requestMonthlyReportGeneration(userId: string, yearMonth: string) {
  const currentMonth = learnerDateKey(new Date(), (await learnerContext(userId)).timezone).slice(0, 7);
  if (yearMonth >= currentMonth) throw badRequest("REPORT_MONTH_NOT_COMPLETED", "Monthly reports can only be generated after the month has completed.");
  await listMonthlyReports(userId);
  const report = await prisma.learnerMonthlyReport.findUnique({ where: { userId_yearMonth: { userId, yearMonth } } });
  if (!report) throw notFound("MONTHLY_REPORT_NOT_FOUND", "This completed-month report is not available for the purchased period.");
  if (report.status === "READY") return reportListItem(report);
  await prisma.learnerMonthlyReport.update({ where: { id: report.id }, data: { status: "PENDING", failureCode: null } });
  await enqueueJob({ kind: MONTHLY_REPORT_JOB, payload: { reportId: report.id }, deduplicationKey: `monthly-report:${report.id}:v${report.version}`, runAt: new Date() });
  return { ...reportListItem({ ...report, status: "PENDING", failureCode: null }), queued: true };
}

export async function scheduleMonthlyReportForEntitlement(db: Db, input: { userId: string; courseId: string; contentItemId: string; entitlementId: string; orderId?: string | null; grantedAt: Date }) {
  const product = await db.contentItem.findFirst({ where: { id: input.contentItemId, courseId: input.courseId, entityType: "MONTHLY_REPORT", status: "PUBLISHED", deletedAt: null } });
  if (!product) return;
  const preference = await db.learnerPreference.findUnique({ where: { userId: input.userId }, select: { timezone: true } });
  const course = await db.course.findUniqueOrThrow({ where: { id: input.courseId }, select: { code: true, name: true } });
  const timezone = preference?.timezone || "Asia/Kolkata";
  const { yearMonth, start, end, runAt } = monthlyReportSchedule(input.grantedAt, timezone);
  const report = await db.learnerMonthlyReport.upsert({
    where: { userId_yearMonth: { userId: input.userId, yearMonth } },
    create: { userId: input.userId, courseId: input.courseId, yearMonth, timezone, courseCodeSnapshot: course.code, courseNameSnapshot: course.name, periodStart: start, periodEndExclusive: end, totalStudySeconds: 0, focusSeconds: 0, readingSeconds: 0, practiceSeconds: 0, revisionSeconds: 0, activeDays: 0, goalDays: 0, streakDays: 0, protectedDays: 0, notesCompleted: 0, revisionsCompleted: 0, studyTasksCompleted: 0, totalNotes: 0, syllabusCompleted: 0, syllabusPercent: 0, weeklyStudySeconds: [0, 0, 0, 0, 0], algorithmVersion: ALGORITHM_VERSION, productContentItemId: product.id, entitlementId: input.entitlementId, orderId: input.orderId, status: "PENDING" },
    update: { productContentItemId: product.id, entitlementId: input.entitlementId, orderId: input.orderId },
  });
  if (report.status !== "READY") await enqueueJob({ kind: MONTHLY_REPORT_JOB, payload: { reportId: report.id }, deduplicationKey: `monthly-report:${report.id}:v${report.version}`, runAt }, db);
}

type Attempt = Awaited<ReturnType<typeof loadReportData>>["attempts"][number];

async function loadReportData(userId: string, courseId: string, yearMonth: string, timezone: string) {
  const months = Array.from({ length: 7 }, (_, index) => shiftMonth(yearMonth, index - 6));
  const { start } = monthBounds(months[0]); const { end } = monthBounds(yearMonth);
  const coarseStart = new Date(start.getTime() - 2 * 86_400_000); const coarseEnd = new Date(end.getTime() + 2 * 86_400_000);
  const [activities, streakDays, attempts, tests, contentItems, noteStates, studyTasks, revisions] = await Promise.all([
    prisma.learnerDailyActivity.findMany({ where: { userId, localDate: { gte: start, lt: end } }, orderBy: { localDate: "asc" } }),
    prisma.learnerStreakDay.findMany({ where: { userId, localDate: { gte: start, lt: end } }, orderBy: { localDate: "asc" } }),
    prisma.practiceAttempt.findMany({ where: { userId, createdAt: { gte: coarseStart, lt: coarseEnd }, sessionQuestion: { session: { courseId } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, correct: true, createdAt: true, sessionQuestion: { select: { difficulty: true, subjectId: true, chapterId: true, topicId: true } } } }),
    prisma.practiceSession.findMany({ where: { userId, courseId, collection: "MTP", status: "COMPLETED", completedAt: { gte: coarseStart, lt: coarseEnd } }, orderBy: [{ completedAt: "asc" }, { id: "asc" }], select: { id: true, completedAt: true, answeredCount: true, correctCount: true } }),
    prisma.contentItem.findMany({ where: reportContentWhere(courseId), select: { id: true } }),
    prisma.learnerNoteState.findMany({ where: { userId, contentItem: reportContentWhere(courseId) }, select: { contentItemId: true, progressPercent: true, completed: true, completedAt: true, firstOpenedAt: true } }),
    prisma.learnerStudyTask.findMany({ where: { userId, completedAt: { gte: coarseStart, lt: coarseEnd }, plan: { courseId } }, select: { completedAt: true } }),
    prisma.noteRevisionEvent.findMany({ where: { userId, revisedAt: { gte: coarseStart, lt: coarseEnd }, noteState: { contentItem: reportContentWhere(courseId) } }, select: { revisedAt: true } }),
  ]);
  const subjectIds = [...new Set(attempts.map((item) => item.sessionQuestion.subjectId).filter((id): id is string => Boolean(id)))];
  const chapterIds = [...new Set(attempts.map((item) => item.sessionQuestion.chapterId).filter((id): id is string => Boolean(id)))];
  const topicIds = [...new Set(attempts.map((item) => item.sessionQuestion.topicId).filter((id): id is string => Boolean(id)))];
  const [subjects, chapters, topics] = await Promise.all([
    prisma.subject.findMany({ where: { id: { in: subjectIds }, courseId }, select: { id: true, name: true } }),
    prisma.taxonomyChapter.findMany({ where: { id: { in: chapterIds }, courseId }, select: { id: true, name: true } }),
    prisma.taxonomyTopic.findMany({
      where: {
        id: { in: topicIds },
        lesson: { chapter: { courseId } },
      },
      select: { id: true, name: true },
    }),
  ]);
  return { months, activities, streakDays, attempts, tests, contentItems, noteStates, studyTasks, revisions, subjects, chapters, topics, timezone };
}

function attemptsForMonth(attempts: Attempt[], yearMonth: string, timezone: string) { return attempts.filter((item) => inLearnerMonth(item.createdAt, yearMonth, timezone)); }
function attemptStats(items: Attempt[]) { const attempted = items.length; const correct = items.filter((item) => item.correct === true).length; return { attempted, correct, accuracy: percent(correct, attempted) }; }

function longestStreak(dates: Date[]) {
  let longest = 0; let run = 0; let previous: number | null = null;
  for (const date of dates) { const day = date.getTime(); run = previous !== null && day - previous === 86_400_000 ? run + 1 : 1; longest = Math.max(longest, run); previous = day; }
  return longest;
}

async function buildSnapshot(report: { id: string; userId: string; courseId: string; yearMonth: string }, context: { userId: string; fullName: string; timezone: string; dailyTargetMinutes: number; course: { id: string; code: string; name: string } }) {
  const data = await loadReportData(report.userId, report.courseId, report.yearMonth, context.timezone);
  const previousMonth = shiftMonth(report.yearMonth, -1);
  const currentAttempts = attemptsForMonth(data.attempts, report.yearMonth, context.timezone);
  const previousAttempts = attemptsForMonth(data.attempts, previousMonth, context.timezone);
  const currentStats = attemptStats(currentAttempts); const previousStats = attemptStats(previousAttempts);
  const currentActivities = data.activities.filter((item) => databaseDateKey(item.localDate).startsWith(report.yearMonth));
  const previousActivities = data.activities.filter((item) => databaseDateKey(item.localDate).startsWith(previousMonth));
  const currentActivity = summarizeMonthlyActivity(currentActivities); const previousActivity = summarizeMonthlyActivity(previousActivities);
  const currentTests = data.tests.filter((item) => inLearnerMonth(item.completedAt, report.yearMonth, context.timezone));
  const previousTests = data.tests.filter((item) => inLearnerMonth(item.completedAt, previousMonth, context.timezone));
  const completedCurrent = data.noteStates.filter((item) => inLearnerMonth(item.completedAt, report.yearMonth, context.timezone)).length;
  const completedPrevious = data.noteStates.filter((item) => inLearnerMonth(item.completedAt, previousMonth, context.timezone)).length;
  const revisionsCompleted = data.revisions.filter((item) => inLearnerMonth(item.revisedAt, report.yearMonth, context.timezone)).length;
  const protectedDays = data.streakDays.filter((item) => databaseDateKey(item.localDate).startsWith(report.yearMonth) && item.protectedAt).length;
  const previousDataAvailable = previousAttempts.length > 0 || previousActivities.some((item) => item.focusSeconds + item.readingSeconds + item.practiceSeconds + item.revisionSeconds > 0) || previousTests.length > 0 || completedPrevious > 0;
  const sourceMap = new Map(data.noteStates.map((item) => [item.contentItemId, item]));
  const monthEnd = `${shiftMonth(report.yearMonth, 1)}-01`; const previousEnd = `${report.yearMonth}-01`;
  const completionAt = (endKey: string) => data.contentItems.reduce((acc, item) => { const state = sourceMap.get(item.id); if (state?.completedAt && learnerDateKey(state.completedAt, context.timezone) < endKey) acc.completed += 1; else if (state?.firstOpenedAt && learnerDateKey(state.firstOpenedAt, context.timezone) < endKey) acc.inProgress += 1; else acc.notStarted += 1; return acc; }, { completed: 0, inProgress: 0, notStarted: 0 });
  const completion = completionAt(monthEnd); const previousCompletion = completionAt(previousEnd); const totalConcepts = data.contentItems.length;
  const subjectNames = new Map(data.subjects.map((item) => [item.id, item.name]));
  const performanceFor = (items: Attempt[]) => { const map = new Map<string, { attempted: number; correct: number }>(); for (const item of items) { const id = item.sessionQuestion.subjectId; if (!id) continue; const value = map.get(id) ?? { attempted: 0, correct: 0 }; value.attempted += 1; if (item.correct) value.correct += 1; map.set(id, value); } return map; };
  const currentSubjects = performanceFor(currentAttempts); const previousSubjects = performanceFor(previousAttempts);
  const subjectPerformance = [...currentSubjects.entries()].map(([subjectId, value]) => { const currentAccuracy = percent(value.correct, value.attempted); const previous = previousSubjects.get(subjectId); const previousAccuracy = previous ? percent(previous.correct, previous.attempted) : null; return { subjectId, name: subjectNames.get(subjectId) ?? "Subject", attempted: value.attempted, currentAccuracy, previousAccuracy, changePoints: currentAccuracy !== null && previousAccuracy !== null ? round(currentAccuracy - previousAccuracy, 1) : null }; }).sort((a, b) => b.attempted - a.attempted || a.name.localeCompare(b.name));
  const chapterNames = new Map(data.chapters.map((item) => [item.id, item.name])); const topicNames = new Map(data.topics.map((item) => [item.id, item.name]));
  const areas = new Map<string, { name: string; attempted: number; correct: number }>();
  for (const item of currentAttempts) { const id = item.sessionQuestion.topicId ?? item.sessionQuestion.chapterId ?? item.sessionQuestion.subjectId; if (!id) continue; const name = topicNames.get(id) ?? chapterNames.get(id) ?? subjectNames.get(id) ?? "Concept"; const value = areas.get(id) ?? { name, attempted: 0, correct: 0 }; value.attempted += 1; if (item.correct) value.correct += 1; areas.set(id, value); }
  const areaRows = [...areas.values()].filter((item) => item.attempted >= 2).map((item) => ({ name: item.name, attempted: item.attempted, accuracyPercent: percent(item.correct, item.attempted) ?? 0 }));
  const difficultyLabels = { FOUNDATION: "Easy", INTERMEDIATE: "Medium", ADVANCED: "Hard" } as const;
  const distribution = (["FOUNDATION", "INTERMEDIATE", "ADVANCED"] as const).map((difficulty) => { const count = currentAttempts.filter((item) => item.sessionQuestion.difficulty === difficulty).length; return { label: difficultyLabels[difficulty], count, percent: percent(count, currentAttempts.length) ?? 0 }; });
  const days = monthBounds(report.yearMonth).days; const activityMap = new Map(currentActivities.map((item) => [databaseDateKey(item.localDate), item]));
  const maxStudy = Math.max(1, ...currentActivities.map((item) => item.focusSeconds + item.readingSeconds + item.practiceSeconds + item.revisionSeconds));
  const consistency = Array.from({ length: days }, (_, index) => { const date = databaseDate(`${report.yearMonth}-${String(index + 1).padStart(2, "0")}`); const row = activityMap.get(databaseDateKey(date)); const studySeconds = row ? row.focusSeconds + row.readingSeconds + row.practiceSeconds + row.revisionSeconds : 0; return { date: databaseDateKey(date), weekday: ((date.getUTCDay() + 6) % 7) + 1, week: Math.floor(index / 7), studySeconds, intensity: studySeconds ? Math.max(1, Math.min(4, Math.ceil(studySeconds / maxStudy * 4))) : 0 }; });
  const testRows = currentTests.map((item, index) => ({ label: `Test ${index + 1}`, score: percent(item.correctCount, item.answeredCount) ?? 0 }));
  const bestRow = testRows.length ? [...testRows].sort((a, b) => b.score - a.score)[0] : null; const lowestRow = testRows.length ? [...testRows].sort((a, b) => a.score - b.score)[0] : null;
  const best = bestRow ? { title: bestRow.label, score: bestRow.score } : null; const lowest = lowestRow ? { title: lowestRow.label, score: lowestRow.score } : null;
  const monthlyTrend = data.months.slice(1).map((yearMonth) => { const stats = attemptStats(attemptsForMonth(data.attempts, yearMonth, context.timezone)); return { yearMonth, label: monthLabel(yearMonth).split(" ")[0], attempted: stats.attempted, correct: stats.correct, accuracyPercent: stats.accuracy }; });
  const weekAttempts = Array.from({ length: 5 }, () => [] as Attempt[]); currentAttempts.forEach((item) => weekAttempts[Math.min(4, Math.floor((Number(learnerDateKey(item.createdAt, context.timezone).slice(8, 10)) - 1) / 7))].push(item));
  const weeklyAccuracy = weekAttempts.map((items, index) => ({ label: `Week ${index + 1}`, attempted: items.length, accuracyPercent: attemptStats(items).accuracy }));
  const goalPercent = currentActivities.length ? Math.min(100, round(currentActivity.goalDays / days * 100, 0)) : 0;
  const syllabusPercent = totalConcepts ? round(completion.completed / totalConcepts * 100, 0) : 0; const previousSyllabusPercent = totalConcepts ? round(previousCompletion.completed / totalConcepts * 100, 0) : null;
  const message = currentStats.attempted === 0 && currentActivity.totalStudySeconds === 0 ? { title: "Your next month starts here.", body: "No learning activity was recorded for this month. Begin with one focused session and a short practice set." } : currentStats.accuracy !== null && currentStats.accuracy < 50 ? { title: "Build accuracy through review.", body: "Your activity is visible. Revisit the listed weak areas before attempting another focused practice set." } : { title: `Keep the momentum, ${context.fullName.split(" ")[0]}!`, body: "Your report reflects real progress. Continue steady study sessions and revisit weaker concepts to improve accuracy." };
  const source = { currentAttempts, previousAttempts, currentActivities, previousActivities, currentTests, previousTests, completion, previousCompletion, revisionsCompleted, protectedDays, currentTasks: data.studyTasks.filter((item) => inLearnerMonth(item.completedAt, report.yearMonth, context.timezone)).length };
  const sourceDataHash = createHash("sha256").update(JSON.stringify(source, (_key, value) => value instanceof Date ? value.toISOString() : value)).digest("hex");
  const generatedAt = new Date().toISOString();
  const snapshot: MonthlyReportSnapshot = {
    schemaVersion: 2, algorithmVersion: ALGORITHM_VERSION,
    generatedFor: { userId: report.userId, fullName: context.fullName, courseId: context.course.id, courseCode: context.course.code, courseName: context.course.name, timezone: context.timezone },
    period: { yearMonth: report.yearMonth, label: monthLabel(report.yearMonth), previousYearMonth: previousMonth, previousLabel: monthLabel(previousMonth), start: `${report.yearMonth}-01`, endExclusive: monthEnd },
    header: { studyStreakDays: longestStreak(data.streakDays.filter((item) => databaseDateKey(item.localDate).startsWith(report.yearMonth)).map((item) => item.localDate)), monthlyGoalPercent: goalPercent, previousDataAvailable },
    summary: { mcqsAttempted: currentStats.attempted, mcqsCorrect: currentStats.correct, accuracyPercent: currentStats.accuracy, conceptsCompleted: completedCurrent, studyHours: round(currentActivity.totalStudySeconds / 3600, 1), testsTaken: currentTests.length, deltas: {
      mcqsAttempted: previousDataAvailable ? delta(currentStats.attempted, previousStats.attempted, "COUNT") : null,
      mcqsCorrect: previousDataAvailable ? delta(currentStats.correct, previousStats.correct, "COUNT") : null,
      accuracyPercent: previousDataAvailable && currentStats.accuracy !== null && previousStats.accuracy !== null ? delta(currentStats.accuracy, previousStats.accuracy, "PERCENTAGE_POINTS") : null,
      conceptsCompleted: previousDataAvailable ? delta(completedCurrent, completedPrevious, "COUNT") : null,
      studyHours: previousDataAvailable ? delta(currentActivity.totalStudySeconds / 3600, previousActivity.totalStudySeconds / 3600, "HOURS") : null,
      testsTaken: previousDataAvailable ? delta(currentTests.length, previousTests.length, "COUNT") : null,
    } },
    monthlyTrend, weeklyAccuracy, subjectPerformance,
    conceptCompletion: { ...completion, total: totalConcepts },
    strengths: [...areaRows].sort((a, b) => b.accuracyPercent - a.accuracyPercent || b.attempted - a.attempted).slice(0, 3),
    weakAreas: [...areaRows].sort((a, b) => a.accuracyPercent - b.accuracyPercent || b.attempted - a.attempted).slice(0, 3),
    practiceDistribution: distribution, consistency,
    testPerformance: { available: testRows.length > 0, testsTaken: testRows.length, averageScore: testRows.length ? round(testRows.reduce((sum, item) => sum + item.score, 0) / testRows.length, 1) : null, best, lowest, trend: testRows },
    overallProgress: { syllabusPercent, previousSyllabusPercent, changePoints: previousSyllabusPercent === null ? null : round(syllabusPercent - previousSyllabusPercent, 1), messageTitle: message.title, messageBody: message.body, rank: null },
    audit: { sourceDataHash, generatedAt },
  };
  return { snapshot, activity: currentActivity, completion, completedCurrent, revisionsCompleted, protectedDays, currentTasks: source.currentTasks, sourceDataHash };
}

/** Development-only preview which does not update report status or its month-end job. */
export async function generateMonthlyReportPreviewForTesting(reportId: string) {
  if (getConfig().environment === "production") throw forbidden("MONTHLY_REPORT_PREVIEW_DISABLED", "Monthly Report preview generation is disabled in production.");
  const report = await prisma.learnerMonthlyReport.findUnique({ where: { id: reportId } });
  if (!report) throw notFound("MONTHLY_REPORT_NOT_FOUND", "The monthly report was not found.");
  const context = await reportContext(report.userId, report.courseId);
  if (!report.productContentItemId || !await reportEntitlement(report.userId, report.productContentItemId)) throw forbidden("MONTHLY_REPORT_ENTITLEMENT_REQUIRED", "An active Monthly Report purchase is required.");
  const built = await buildSnapshot(report, context);
  const pdf = await generateMonthlyReportPdf(built.snapshot);
  if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("INVALID_GENERATED_PDF");
  return { pdf, snapshot: built.snapshot, report };
}

export async function generateMonthlyReport(reportId: string) {
  const claimed = await prisma.learnerMonthlyReport.updateMany({ where: { id: reportId, status: { in: ["PENDING", "FAILED"] } }, data: { status: "GENERATING", failureCode: null } });
  const report = await prisma.learnerMonthlyReport.findUnique({ where: { id: reportId } });
  if (!report) throw notFound("MONTHLY_REPORT_NOT_FOUND", "The report generation request was not found.");
  if (!claimed.count && report.status === "READY") {
    await enqueueJob({ kind: MONTHLY_REPORT_EMAIL_JOB, payload: { reportId: report.id, version: report.version }, deduplicationKey: `monthly-report-email:${report.id}:v${report.version}`, runAt: new Date() });
    return { reportId, status: "READY", unchanged: true };
  }
  if (!claimed.count && report.status === "GENERATING") return { reportId, status: "GENERATING" };
  try {
    const context = await reportContext(report.userId, report.courseId);
    if (!report.productContentItemId || !await reportEntitlement(report.userId, report.productContentItemId)) throw forbidden("MONTHLY_REPORT_ENTITLEMENT_REQUIRED", "The Monthly Report entitlement is no longer active.");
    const built = await buildSnapshot(report, context);
    if (report.status === "READY" && report.sourceDataHash === built.sourceDataHash && report.storageKey) return { reportId, status: "READY", unchanged: true };
    const pdf = await generateMonthlyReportPdf(built.snapshot);
    if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("INVALID_GENERATED_PDF");
    const checksum = createHash("sha256").update(pdf).digest("hex");
    const version = report.sourceDataHash && report.sourceDataHash !== built.sourceDataHash ? report.version + 1 : report.version;
    const storageKey = `monthly-reports/${report.userId}/${report.yearMonth}/v${version}-${built.sourceDataHash}.pdf`;
    const storage = getStorageProvider();
    if (!storage.putObject) throw serviceUnavailable("STORAGE_UPLOAD_UNSUPPORTED", "The configured storage provider cannot store generated reports.");
    await storage.putObject(storageKey, pdf, "application/pdf", checksum);
    await prisma.learnerMonthlyReport.update({ where: { id: report.id }, data: {
      status: "READY", snapshotJson: safeJson(built.snapshot), sourceDataHash: built.sourceDataHash, storageKey, pdfChecksumSha256: checksum, pdfSizeBytes: BigInt(pdf.length), version, failureCode: null, generatedAt: new Date(built.snapshot.audit.generatedAt), algorithmVersion: ALGORITHM_VERSION,
      totalStudySeconds: built.activity.totalStudySeconds, focusSeconds: built.activity.focusSeconds, readingSeconds: built.activity.readingSeconds, practiceSeconds: built.activity.practiceSeconds, revisionSeconds: built.activity.revisionSeconds,
      activeDays: built.activity.activeDays, goalDays: built.activity.goalDays, streakDays: built.snapshot.header.studyStreakDays, protectedDays: built.protectedDays, notesCompleted: built.completedCurrent, revisionsCompleted: built.revisionsCompleted, studyTasksCompleted: built.currentTasks,
      totalNotes: built.snapshot.conceptCompletion.total, syllabusCompleted: built.completion.completed, syllabusPercent: built.snapshot.overallProgress.syllabusPercent, weeklyStudySeconds: built.activity.weeklyStudySeconds,
    } });

    await enqueueJob({
      kind: MONTHLY_REPORT_EMAIL_JOB,
      payload: { reportId: report.id, version },
      deduplicationKey: `monthly-report-email:${report.id}:v${version}`,
      runAt: new Date(),
    });

    try {
      const monthTitle = monthLabel(report.yearMonth);
      const notificationKey = `monthly-report-ready:${report.id}:v${version}`;
      const notification = await createLearnerNotification({
        userId: report.userId,
        category: "DAILY_PLAN",
        title: "Your Monthly Report is Ready! 📊",
        body: `Your learning & progress report for ${monthTitle} is now available. Tap to view your performance insights.`,
        sourceKey: notificationKey,
        data: { url: "/monthly-report", reportId: report.id, yearMonth: report.yearMonth },
      });
      if (notification) {
        await enqueueJob({
          kind: "LEARNER_PUSH_DELIVERY",
          payload: { sourceKey: notificationKey },
          deduplicationKey: notificationKey,
        });
      }
    } catch {
      // Safe non-blocking notification error handling
    }

    return { reportId, status: "READY", version, sizeBytes: pdf.length, checksum };
  } catch (error) {
    await prisma.learnerMonthlyReport.updateMany({ where: { id: reportId, status: "GENERATING" }, data: { status: "FAILED", failureCode: error instanceof Error ? error.message.slice(0, 80).replace(/[^A-Z0-9_:-]/gi, "_") : "REPORT_GENERATION_FAILED" } });
    throw error;
  }
}

export async function processMonthlyReportsFor1stOfMonth() {
  const now = new Date();
  const activeEntitlements = await prisma.entitlement.findMany({
    where: {
      resourceType: "MONTHLY_REPORT",
      status: "ACTIVE",
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { userId: true, courseId: true, contentItemId: true, id: true, orderId: true, purchasedAt: true, grantedAt: true },
  });

  const processed: Array<{ userId: string; yearMonth: string; reportId: string }> = [];

  for (const entitlement of activeEntitlements) {
    if (!entitlement.courseId) continue;
    try {
      const purchasedAt = entitlement.purchasedAt ?? entitlement.grantedAt;
      if (entitlement.contentItemId) {
        await scheduleMonthlyReportForEntitlement(prisma, {
          userId: entitlement.userId,
          courseId: entitlement.courseId,
          contentItemId: entitlement.contentItemId,
          entitlementId: entitlement.id,
          orderId: entitlement.orderId,
          grantedAt: purchasedAt,
        });
      }
      const preference = await prisma.learnerPreference.findUnique({
        where: { userId: entitlement.userId },
        select: { timezone: true },
      });
      const timezone = preference?.timezone || "Asia/Kolkata";
      const course = await prisma.course.findUnique({
        where: { id: entitlement.courseId },
        select: { code: true, name: true },
      });
      if (!course) continue;

      // Maintenance owns report creation. Archive reads are intentionally
      // side-effect free, and a missed worker window is safely caught up here.
      for (const yearMonth of completedMonths(purchasedAt, timezone)) {
        const { start, end } = monthBounds(yearMonth);
        const report = await prisma.learnerMonthlyReport.upsert({
          where: { userId_yearMonth: { userId: entitlement.userId, yearMonth } },
          create: {
            userId: entitlement.userId,
            courseId: entitlement.courseId,
            yearMonth,
            timezone,
            courseCodeSnapshot: course.code,
            courseNameSnapshot: course.name,
            periodStart: start,
            periodEndExclusive: end,
            totalStudySeconds: 0, focusSeconds: 0, readingSeconds: 0, practiceSeconds: 0, revisionSeconds: 0,
            activeDays: 0, goalDays: 0, streakDays: 0, protectedDays: 0, notesCompleted: 0, revisionsCompleted: 0,
            studyTasksCompleted: 0, totalNotes: 0, syllabusCompleted: 0, syllabusPercent: 0,
            weeklyStudySeconds: [0, 0, 0, 0, 0], algorithmVersion: ALGORITHM_VERSION,
            productContentItemId: entitlement.contentItemId, entitlementId: entitlement.id, orderId: entitlement.orderId, status: "PENDING",
          },
          update: {
            productContentItemId: entitlement.contentItemId, entitlementId: entitlement.id, orderId: entitlement.orderId,
          },
        });

        if (report.status === "PENDING" || report.status === "FAILED") {
          await enqueueJob({
            kind: MONTHLY_REPORT_JOB,
            payload: { reportId: report.id },
            deduplicationKey: `monthly-report:${report.id}:v${report.version}`,
            runAt: new Date(),
          });
        }
        processed.push({ userId: entitlement.userId, yearMonth, reportId: report.id });
      }
    } catch {
      // Continue processing other entitlements safely
    }
  }

  return { processedCount: processed.length, processed };
}
