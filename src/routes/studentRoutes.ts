import { Router } from "express";
import { z } from "zod";
import { asyncRoute } from "../middleware/async-route.js";
import * as student from "../services/studentService.js";
import * as preferences from "../services/learnerPreferenceService.js";
import * as viewer from "../services/noteViewerService.js";
import * as notes from "../services/noteCatalogService.js";
import * as library from "../services/studentLibraryService.js";
import * as practice from "../services/practiceService.js";
import * as rewards from "../services/rewardService.js";
import * as focus from "../services/focusService.js";
import * as streak from "../services/streakService.js";
import * as tracker from "../services/trackerService.js";
import * as studyPlan from "../services/studyPlanService.js";
import * as monthlyReports from "../services/monthlyReportService.js";
import * as monthlyReportViewer from "../services/monthlyReportViewerService.js";
import * as account from "../services/studentAccountService.js";
import { badRequest } from "../errors/api-error.js";

const uuid = z.string().uuid();
const practiceMode = z.enum(["MCQ", "CASE_STUDY", "QUESTION_BANK", "WRONG_ANSWERS", "REVISIT"]);
const practiceSource = z.object({ sourceKind: z.literal("ARCHIVE").default("ARCHIVE"), mode: practiceMode.optional(), questionBankId: uuid.optional() }).strict();
const practiceFilters = z.object({ sourceKind: z.literal("ARCHIVE").default("ARCHIVE"), mode: practiceMode, questionBankId: uuid.optional(), contentItemIds: z.array(uuid).min(1).max(100).optional(), subjectId: uuid.optional(), chapterId: uuid.optional(), lessonId: uuid.optional(), topicId: uuid.optional(), collection: z.enum(["PYQ", "RTP", "MTP", "ORIGINAL", "QUESTION_BANK"]).optional(), year: z.number().int().min(1900).max(2100).optional(), answerFormat: z.enum(["MCQ", "DESCRIPTIVE", "CASE_STUDY"]), questionCount: z.number().int().min(1).max(100).optional(), timerSeconds: z.number().int().min(30).max(86400).optional() }).strict();
export const studentDomainRouter = Router();
studentDomainRouter.get("/bootstrap", asyncRoute(async (req, res) => { res.json(await student.getBootstrap(req.auth!.userId, req.auth!.sessionId)); }));
const preferenceBase = z.object({ selectedCourseId: uuid, examMonth: z.number().int().min(1).max(12), examYear: z.number().int().min(2020).max(2100), examDay: z.number().int().min(1).max(31).optional(), academyReference: z.string().trim().max(120).optional(), dailyTargetMinutes: z.number().int().min(15).max(720), timezone: z.string().trim().min(1).max(80), language: z.string().trim().min(1).max(40).optional(), reminderTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), expectedVersion: z.number().int().min(0).optional() });
studentDomainRouter.get("/preferences/options", asyncRoute(async (req, res) => { res.json(await preferences.listPreferenceOptions(req.auth!.userId)); }));
studentDomainRouter.get("/preferences", asyncRoute(async (req, res) => { res.json(await preferences.getPreferences(req.auth!.userId)); }));
studentDomainRouter.put("/preferences", asyncRoute(async (req, res) => { res.json(await preferences.putPreferences(req.auth!.userId, preferenceBase.strict().parse(req.body))); }));
studentDomainRouter.patch("/preferences", asyncRoute(async (req, res) => { const body = preferenceBase.omit({ selectedCourseId: true }).partial().strict().refine((value) => Object.keys(value).length > 0).parse(req.body); res.json(await preferences.patchPreferences(req.auth!.userId, body)); }));
studentDomainRouter.get("/me", asyncRoute(async (req, res) => { res.json(await student.getProfile(req.auth!.userId)); }));
studentDomainRouter.patch("/me", asyncRoute(async (req, res) => { const body = z.object({ fullName: z.string().trim().min(2).max(120) }).strict().parse(req.body); res.json(await student.updateProfile(req.auth!.userId, body)); }));
studentDomainRouter.get("/account", asyncRoute(async (req, res) => { res.json(await account.getStudentAccount(req.auth!.userId)); }));
studentDomainRouter.patch("/account/name", asyncRoute(async (req, res) => { const body = z.object({ fullName: z.string().trim().min(2).max(120) }).strict().parse(req.body); res.json(await account.updateName(req.auth!.userId, body.fullName)); }));
studentDomainRouter.patch("/account/password", asyncRoute(async (req, res) => { const body = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(12).max(128) }).strict().parse(req.body); res.json(await account.changePassword(req.auth!.userId, req.auth!.sessionId, body.currentPassword, body.newPassword)); }));
studentDomainRouter.post("/account/mobile/change/request", asyncRoute(async (req, res) => { const body = z.object({ mobile: z.string().trim().min(7).max(30) }).strict().parse(req.body); res.json(await account.requestVerification(req.auth!.userId, "MOBILE_CHANGE", body.mobile)); }));
studentDomainRouter.post("/account/mobile/change/confirm", asyncRoute(async (req, res) => { const body = z.object({ challengeId: uuid, code: z.string().regex(/^\d{4}$/) }).strict().parse(req.body); res.json(await account.verifyChange(req.auth!.userId, body.challengeId, "MOBILE_CHANGE", body.code)); }));
studentDomainRouter.post("/account/email/change/request", asyncRoute(async (req, res) => { const body = z.object({ email: z.string().trim().email().max(320) }).strict().parse(req.body); res.json(await account.requestEmailChange(req.auth!.userId, body.email)); }));
studentDomainRouter.post("/account/email/change/verify-current", asyncRoute(async (req, res) => { const body = z.object({ challengeId: uuid, code: z.string().regex(/^\d{4}$/) }).strict().parse(req.body); res.json(await account.verifyCurrentEmailForChange(req.auth!.userId, body.challengeId, body.code)); }));
studentDomainRouter.post("/account/email/change/resend", asyncRoute(async (req, res) => { const body = z.object({ challengeId: uuid }).strict().parse(req.body); res.json(await account.resendEmailChangeCode(req.auth!.userId, body.challengeId)); }));
studentDomainRouter.post("/account/email/change/confirm", asyncRoute(async (req, res) => { const body = z.object({ challengeId: uuid, code: z.string().regex(/^\d{4}$/) }).strict().parse(req.body); res.json(await account.confirmEmailChange(req.auth!.userId, body.challengeId, body.code)); }));
studentDomainRouter.post("/account/email/change/verify", asyncRoute(async (req, res) => { const body = z.object({ challengeId: uuid, code: z.string().regex(/^\d{4}$/) }).strict().parse(req.body); res.json(await account.confirmEmailChange(req.auth!.userId, body.challengeId, body.code)); }));
studentDomainRouter.patch("/account/exam", asyncRoute(async (req, res) => { const body = z.object({ examMonth: z.number().int().min(1).max(12), examYear: z.number().int().min(new Date().getUTCFullYear()).max(new Date().getUTCFullYear() + 10), examDay: z.number().int().min(1).max(31).optional(), expectedVersion: z.number().int().min(1).optional() }).strict().parse(req.body); res.json(await account.updateExam(req.auth!.userId, body)); }));
studentDomainRouter.patch("/account/study-target", asyncRoute(async (req, res) => { const body = z.object({ dailyTargetMinutes: z.number().int().min(15).max(720), expectedVersion: z.number().int().min(1).optional() }).strict().parse(req.body); res.json(await account.updateStudyTarget(req.auth!.userId, body.dailyTargetMinutes, body.expectedVersion)); }));
studentDomainRouter.patch("/account/appearance", asyncRoute(async (req, res) => { const body = z.object({ preferredTheme: z.enum(["LIGHT", "DARK"]), expectedVersion: z.number().int().min(1).optional() }).strict().parse(req.body); res.json(await account.updateAppearance(req.auth!.userId, body.preferredTheme, body.expectedVersion)); }));
studentDomainRouter.post("/account/delete/request", asyncRoute(async (req, res) => { z.object({}).strict().parse(req.body ?? {}); res.json(await account.requestVerification(req.auth!.userId, "DELETE_ACCOUNT")); }));
studentDomainRouter.post("/account/delete/verify", asyncRoute(async (req, res) => { const body = z.object({ challengeId: uuid, code: z.string().regex(/^\d{4}$/) }).strict().parse(req.body); res.json(await account.verifyChange(req.auth!.userId, body.challengeId, "DELETE_ACCOUNT", body.code)); }));
studentDomainRouter.get("/memberships", asyncRoute(async (req, res) => { res.json(await student.getMemberships(req.auth!.userId)); }));
studentDomainRouter.get("/active-academy", asyncRoute(async (req, res) => { res.json(await student.getActiveAcademy(req.auth!.userId)); }));
studentDomainRouter.put("/active-academy", asyncRoute(async (req, res) => { const body = z.object({ academyId: uuid }).strict().parse(req.body); res.json(await student.setActiveAcademy(req.auth!.userId, body.academyId)); }));
studentDomainRouter.get("/dashboard", asyncRoute(async (req, res) => { const query = z.object({ academyId: uuid.optional() }).parse(req.query); res.json(await student.getDashboard(req.auth!.userId, query.academyId)); }));
studentDomainRouter.get("/courses", asyncRoute(async (req, res) => { const query = z.object({ academyId: uuid.optional() }).parse(req.query); res.json(await student.listCourses(req.auth!.userId, query.academyId)); }));
studentDomainRouter.get("/courses/:courseId", asyncRoute(async (req, res) => { res.json(await student.getCourse(req.auth!.userId, uuid.parse(req.params.courseId))); }));
studentDomainRouter.get("/courses/:courseId/content", asyncRoute(async (req, res) => { const query = z.object({ parentId: uuid.nullish() }).parse(req.query); res.json(await student.listCourseContent(req.auth!.userId, uuid.parse(req.params.courseId), query.parentId)); }));
studentDomainRouter.get("/packages", asyncRoute(async (req, res) => {
  const query = z.object({ search: z.string().trim().max(160).optional(), ownership: z.enum(["all", "owned", "available"]).default("all"), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
  res.json(await library.listPackages(req.auth!.userId, query));
}));
studentDomainRouter.get("/packages/:packageId", asyncRoute(async (req, res) => {
  res.json(await library.getPackage(req.auth!.userId, uuid.parse(req.params.packageId)));
}));
studentDomainRouter.get("/library", asyncRoute(async (req, res) => {
  const query = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
  res.json(await library.getLibrary(req.auth!.userId, query));
}));
studentDomainRouter.get("/entitlements", asyncRoute(async (req, res) => {
  const query = z.object({ status: z.enum(["ACTIVE", "EXPIRING_SOON", "EXPIRED", "REVOKED"]).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
  res.json(await library.listEntitlements(req.auth!.userId, query));
}));
studentDomainRouter.get("/entitlements/:entitlementId", asyncRoute(async (req, res) => {
  res.json(await library.getEntitlement(req.auth!.userId, uuid.parse(req.params.entitlementId)));
}));
studentDomainRouter.get("/store/resources", asyncRoute(async (req, res) => {
  const query = z.object({ search: z.string().trim().max(160).optional(), type: z.enum(["all", "note", "package"]).default("all"), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
  res.json(await library.listStoreResources(req.auth!.userId, query));
}));
studentDomainRouter.get("/practice/sources", asyncRoute(async (req, res) => {
  res.json(await practice.listPracticeSources(req.auth!.userId));
}));
studentDomainRouter.get("/practice/modes", asyncRoute(async (req, res) => {
  res.json(await practice.listPracticeModes(req.auth!.userId));
}));
studentDomainRouter.get("/practice/search", asyncRoute(async (req, res) => {
  const query = z.object({ mode: practiceMode, questionBankId: uuid.optional(), q: z.string().trim().max(160).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
  res.json(await practice.searchPracticeScope(req.auth!.userId, { mode: query.mode, questionBankId: query.questionBankId, query: query.q, limit: query.limit }));
}));
studentDomainRouter.get("/practice/question-banks", asyncRoute(async (req, res) => {
  res.json(await practice.listQuestionBanks(req.auth!.userId));
}));
studentDomainRouter.get("/practice/filters", asyncRoute(async (req, res) => {
  const query = practiceSource.parse(req.query);
  res.json(await practice.getPracticeFilters(req.auth!.userId, query));
}));
studentDomainRouter.post("/practice/sets/preview", asyncRoute(async (req, res) => {
  res.json(await practice.previewPracticeSet(req.auth!.userId, practiceFilters.parse(req.body)));
}));
studentDomainRouter.post("/practice/sessions", asyncRoute(async (req, res) => {
  res.status(201).json(await practice.createPracticeSession(req.auth!.userId, practiceFilters.parse(req.body)));
}));
studentDomainRouter.get("/practice/sessions/resume", asyncRoute(async (req, res) => {
  res.json(await practice.getResumablePracticeSession(req.auth!.userId));
}));
studentDomainRouter.get("/practice/sessions/:sessionId", asyncRoute(async (req, res) => {
  res.json(await practice.getPracticeSession(req.auth!.userId, uuid.parse(req.params.sessionId)));
}));
studentDomainRouter.get("/practice/sessions/:sessionId/result", asyncRoute(async (req, res) => {
  res.json(await practice.getPracticeResult(req.auth!.userId, uuid.parse(req.params.sessionId)));
}));
studentDomainRouter.get("/practice/sessions/:sessionId/questions", asyncRoute(async (req, res) => {
  const query = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
  res.json(await practice.listSessionQuestions(req.auth!.userId, uuid.parse(req.params.sessionId), query.page, query.limit));
}));
studentDomainRouter.post("/practice/sessions/:sessionId/questions/:sessionQuestionId/attempts", asyncRoute(async (req, res) => {
  const body = z.object({ clientAttemptId: z.string().trim().min(1).max(100), answerOptionLabel: z.string().trim().length(1).optional(), answerText: z.string().trim().min(1).max(50_000).optional(), durationMs: z.number().int().min(0).max(86_400_000).optional() }).strict().refine((value) => value.answerOptionLabel !== undefined || value.answerText !== undefined).parse(req.body);
  res.status(201).json(await practice.submitAttempt(req.auth!.userId, uuid.parse(req.params.sessionId), uuid.parse(req.params.sessionQuestionId), body));
}));
studentDomainRouter.patch("/practice/sessions/:sessionId/questions/:sessionQuestionId/review", asyncRoute(async (req, res) => {
  const body = z.object({ marked: z.boolean() }).strict().parse(req.body);
  res.json(await practice.setMarkedForReview(req.auth!.userId, uuid.parse(req.params.sessionId), uuid.parse(req.params.sessionQuestionId), body.marked));
}));
studentDomainRouter.post("/practice/sessions/:sessionId/complete", asyncRoute(async (req, res) => {
  res.json(await practice.completePracticeSession(req.auth!.userId, uuid.parse(req.params.sessionId)));
}));
studentDomainRouter.get("/practice/tracker", asyncRoute(async (req, res) => {
  res.json(await practice.getPracticeTracker(req.auth!.userId));
}));
studentDomainRouter.get("/practice/wrong-answers", asyncRoute(async (req, res) => {
  const query = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
  res.json(await practice.listWrongAnswers(req.auth!.userId, query));
}));
studentDomainRouter.get("/rewards/wallet", asyncRoute(async (req, res) => {
  res.json(await rewards.getRewardWallet(req.auth!.userId));
}));
studentDomainRouter.get("/rewards/ledger", asyncRoute(async (req, res) => {
  const query = z.object({ cursor: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
  res.json(await rewards.listRewardLedger(req.auth!.userId, query));
}));
studentDomainRouter.get("/rewards/rules", asyncRoute(async (_req, res) => {
  res.json(rewards.getRewardRules());
}));
studentDomainRouter.post("/rewards/claims/:claimId/claim", asyncRoute(async (req, res) => {
  const idempotencyKey = req.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) throw badRequest("IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required.");
  res.json(await rewards.claimReward(req.auth!.userId, uuid.parse(req.params.claimId), idempotencyKey));
}));
studentDomainRouter.get("/focus-sessions/active", asyncRoute(async (req, res) => {
  res.json(await focus.getActiveFocusSession(req.auth!.userId));
}));
studentDomainRouter.post("/focus-sessions", asyncRoute(async (req, res) => {
  const body = z.object({ source: z.enum(["HOME", "TRACKER", "STUDY_TASK", "NOTE"]), sourceId: uuid.optional(), plannedDurationSeconds: z.number().int().min(60).max(86_400).optional() }).strict().parse(req.body);
  const result = await focus.startFocusSession(req.auth!.userId, body);
  res.status(result.created ? 201 : 200).json(result);
}));
studentDomainRouter.post("/focus-sessions/:sessionId/heartbeat", asyncRoute(async (req, res) => {
  res.json(await focus.heartbeatFocusSession(req.auth!.userId, uuid.parse(req.params.sessionId)));
}));
studentDomainRouter.post("/focus-sessions/:sessionId/checkout", asyncRoute(async (req, res) => {
  const idempotencyKey = req.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) throw badRequest("IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required.");
  res.json(await focus.checkoutFocusSession(req.auth!.userId, uuid.parse(req.params.sessionId), idempotencyKey));
}));
studentDomainRouter.post("/focus-sessions/:sessionId/abandon", asyncRoute(async (req, res) => {
  res.json(await focus.abandonFocusSession(req.auth!.userId, uuid.parse(req.params.sessionId)));
}));
studentDomainRouter.get("/focus-sessions", asyncRoute(async (req, res) => {
  const query = z.object({ cursor: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(25), source: z.enum(["HOME", "TRACKER", "STUDY_TASK", "NOTE"]).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }).parse(req.query);
  res.json(await focus.listFocusSessions(req.auth!.userId, query));
}));
studentDomainRouter.get("/daily-summary", asyncRoute(async (req, res) => {
  const query = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
  res.json(await focus.getDailySummary(req.auth!.userId, query.date));
}));
studentDomainRouter.get("/streak", asyncRoute(async (req, res) => {
  res.json(await streak.getStreak(req.auth!.userId));
}));
studentDomainRouter.get("/streak/calendar", asyncRoute(async (req, res) => {
  const query = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).parse(req.query);
  res.json(await streak.getStreakCalendar(req.auth!.userId, query.month));
}));
studentDomainRouter.get("/streak/recoveries/eligible", asyncRoute(async (req, res) => {
  res.json(await streak.getEligibleRecoveries(req.auth!.userId));
}));
studentDomainRouter.post("/streak/recoveries", asyncRoute(async (req, res) => {
  const idempotencyKey = req.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) throw badRequest("IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required.");
  const body = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().parse(req.body);
  res.json(await streak.recoverStreakDay(req.auth!.userId, body.date, idempotencyKey));
}));
studentDomainRouter.get("/tracker/summary", asyncRoute(async (req, res) => {
  const query = z.object({ days: z.coerce.number().pipe(z.union([z.literal(7), z.literal(30), z.literal(90)])).default(7) }).parse(req.query);
  res.json(await tracker.getTrackerSummary(req.auth!.userId, query.days));
}));
studentDomainRouter.get("/revisions/chapters", asyncRoute(async (req, res) => {
  const query = z.object({ filter: z.enum(["all", "due", "not_started"]).default("all"), subjectId: uuid.optional() }).parse(req.query);
  res.json(await tracker.getRevisionChapters(req.auth!.userId, query));
}));
studentDomainRouter.get("/revisions/history", asyncRoute(async (req, res) => {
  const query = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
  res.json(await tracker.getRevisionHistory(req.auth!.userId, query));
}));
const studyPlanDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
studentDomainRouter.get("/study-plan/today", asyncRoute(async (req, res) => {
  const query = z.object({ date: studyPlanDate }).parse(req.query);
  res.json(await studyPlan.getTodayStudyPlan(req.auth!.userId, query.date));
}));
studentDomainRouter.post("/study-plan/generate", asyncRoute(async (req, res) => {
  const body = z.object({ date: studyPlanDate, regenerate: z.boolean().default(false) }).strict().parse(req.body ?? {});
  res.json(await studyPlan.generateStudyPlan(req.auth!.userId, body.date, body.regenerate));
}));
studentDomainRouter.post("/study-plan/tasks", asyncRoute(async (req, res) => {
  const body = z.object({ title: z.string().trim().min(1).max(180), plannedMinutes: z.number().int().min(5).max(720).default(25), date: studyPlanDate }).strict().parse(req.body);
  res.status(201).json(await studyPlan.addManualTask(req.auth!.userId, body));
}));
studentDomainRouter.patch("/study-plan/tasks/:taskId", asyncRoute(async (req, res) => {
  const body = z.object({ action: z.enum(["start", "complete", "reopen", "skip", "reschedule"]), actualMinutes: z.number().int().min(0).max(1440).optional(), date: studyPlanDate }).strict().parse(req.body);
  res.json(await studyPlan.updateStudyTask(req.auth!.userId, uuid.parse(req.params.taskId), body));
}));
studentDomainRouter.delete("/study-plan/tasks/:taskId", asyncRoute(async (req, res) => {
  res.json(await studyPlan.hideStudyTask(req.auth!.userId, uuid.parse(req.params.taskId)));
}));
studentDomainRouter.post("/study-plan/clear-completed", asyncRoute(async (req, res) => {
  const body = z.object({ date: studyPlanDate }).strict().parse(req.body ?? {});
  res.json(await studyPlan.clearCompletedTasks(req.auth!.userId, body.date));
}));
studentDomainRouter.get("/reports/monthly", asyncRoute(async (req, res) => {
  res.json(await monthlyReports.listMonthlyReports(req.auth!.userId));
}));
studentDomainRouter.get("/reports/monthly/:yearMonth", asyncRoute(async (req, res) => {
  const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).parse(req.params.yearMonth);
  res.json(await monthlyReports.getMonthlyReport(req.auth!.userId, yearMonth));
}));
studentDomainRouter.post("/reports/monthly/:yearMonth/generate", asyncRoute(async (req, res) => {
  const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).parse(req.params.yearMonth);
  res.status(202).json(await monthlyReports.requestMonthlyReportGeneration(req.auth!.userId, yearMonth));
}));
studentDomainRouter.post("/reports/monthly/:reportId/viewer-sessions", asyncRoute(async (req, res) => {
  res.status(201).json(await monthlyReportViewer.createMonthlyReportViewerSession(req.auth!.userId, req.auth!.sessionId, uuid.parse(req.params.reportId)));
}));
studentDomainRouter.delete("/reports/monthly/viewer-sessions/:viewerSessionId", asyncRoute(async (req, res) => {
  await monthlyReportViewer.closeMonthlyReportViewerSession(req.auth!.userId, req.auth!.sessionId, uuid.parse(req.params.viewerSessionId));
  res.status(204).end();
}));
studentDomainRouter.get("/notes/tree", asyncRoute(async (req, res) => {
  res.json(await notes.listNoteTree(req.auth!.userId));
}));
studentDomainRouter.get("/notes", asyncRoute(async (req, res) => {
  const query = z.object({
    search: z.string().trim().max(160).optional(),
    status: z.enum(["all", "in_progress", "completed"]).default("all"),
    favourite: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
    parentId: z.union([uuid, z.literal("root").transform(() => null)]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  }).parse(req.query);
  res.json(await notes.listNotes(req.auth!.userId, query));
}));
studentDomainRouter.get("/notes/recent", asyncRoute(async (req, res) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(20).default(3) }).parse(req.query);
  res.json(await notes.listRecentNotes(req.auth!.userId, query.limit));
}));
studentDomainRouter.get("/notes/favourites", asyncRoute(async (req, res) => {
  const query = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
  res.json(await notes.listNotes(req.auth!.userId, { ...query, status: "all", favourite: true }));
}));
studentDomainRouter.get("/notes/:contentItemId", asyncRoute(async (req, res) => {
  res.json(await notes.getNote(req.auth!.userId, uuid.parse(req.params.contentItemId)));
}));
studentDomainRouter.get("/notes/:contentItemId/state", asyncRoute(async (req, res) => {
  const note = await notes.getNote(req.auth!.userId, uuid.parse(req.params.contentItemId));
  res.json({ noteId: note.id, access: note.access, state: note.state });
}));
studentDomainRouter.patch("/notes/:contentItemId/state", asyncRoute(async (req, res) => {
  const body = z.object({ completed: z.boolean().optional(), favourite: z.boolean().optional() }).strict().refine((value) => Object.keys(value).length > 0).parse(req.body);
  res.json(await notes.updateNoteState(req.auth!.userId, uuid.parse(req.params.contentItemId), body));
}));
studentDomainRouter.post("/notes/:contentItemId/revisions", asyncRoute(async (req, res) => {
  const body = z.object({ source: z.enum(["ACTION_SHEET", "READER", "MANUAL"]).default("ACTION_SHEET") }).strict().parse(req.body ?? {});
  res.status(201).json(await notes.addRevision(req.auth!.userId, uuid.parse(req.params.contentItemId), body.source));
}));
studentDomainRouter.post("/notes/:contentItemId/viewer-sessions", asyncRoute(async (req, res) => {
  const result = await viewer.createViewerSession(req.auth!.userId, req.auth!.sessionId, uuid.parse(req.params.contentItemId));
  res.status(201).json(result);
}));
studentDomainRouter.get("/viewer-sessions/:viewerSessionId/manifest", asyncRoute(async (req, res) => {
  res.json(await viewer.getViewerManifest(req.auth!.userId, req.auth!.sessionId, uuid.parse(req.params.viewerSessionId)));
}));
studentDomainRouter.get("/viewer-sessions/:viewerSessionId/content", asyncRoute(async (req, res) => {
  const content = await viewer.getViewerContent(req.auth!.userId, req.auth!.sessionId, uuid.parse(req.params.viewerSessionId));
  const total = content.buffer.length;
  const rangeHeader = req.get("range");
  let start = 0;
  let end = total - 1;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match) { res.status(416).set("Content-Range", `bytes */${total}`).end(); return; }
    if (match[1]) start = Number(match[1]);
    if (match[2]) end = Number(match[2]);
    if (!match[1] && match[2]) { const suffixLength = Number(match[2]); start = Math.max(0, total - suffixLength); end = total - 1; }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= total) { res.status(416).set("Content-Range", `bytes */${total}`).end(); return; }
    end = Math.min(end, total - 1);
  }
  const body = content.buffer.subarray(start, end + 1);
  res.status(rangeHeader ? 206 : 200);
  res.set({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    "Content-Type": content.mimeType,
    "Content-Length": String(body.length),
    "Content-Disposition": `inline; filename="${viewer.safeInlineFileName(content.fileName, content.mimeType)}"`,
    "X-Content-Type-Options": "nosniff",
    "X-Protected-Viewer": "true",
  });
  if (rangeHeader) res.set("Content-Range", `bytes ${start}-${end}/${total}`);
  res.end(body);
}));
studentDomainRouter.patch("/viewer-sessions/:viewerSessionId/progress", asyncRoute(async (req, res) => {
  const body = z.object({ currentPage: z.number().int().min(1).optional(), progressPercent: z.number().int().min(0).max(100), scrollOffset: z.number().min(0).optional() }).strict().parse(req.body);
  res.json(await viewer.updateViewerProgress(req.auth!.userId, req.auth!.sessionId, uuid.parse(req.params.viewerSessionId), body));
}));
studentDomainRouter.post("/viewer-sessions/:viewerSessionId/heartbeat", asyncRoute(async (req, res) => {
  res.json(await viewer.heartbeatViewerSession(req.auth!.userId, req.auth!.sessionId, uuid.parse(req.params.viewerSessionId)));
}));
studentDomainRouter.delete("/viewer-sessions/:viewerSessionId", asyncRoute(async (req, res) => {
  await viewer.closeViewerSession(req.auth!.userId, req.auth!.sessionId, uuid.parse(req.params.viewerSessionId));
  res.status(204).end();
}));
studentDomainRouter.get("/orders", asyncRoute(async (req, res) => { const query = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query); res.json(await student.listOrders(req.auth!.userId, query.page, query.limit)); }));
studentDomainRouter.get("/orders/:orderId/receipt", asyncRoute(async (req, res) => { res.json(await library.getReceipt(req.auth!.userId, uuid.parse(req.params.orderId))); }));
studentDomainRouter.get("/orders/:orderId", asyncRoute(async (req, res) => { res.json(await student.getOrder(req.auth!.userId, uuid.parse(req.params.orderId))); }));
studentDomainRouter.get("/questions", asyncRoute(async (req, res) => {
  const query = z.object({
    courseId: uuid.optional(),
    subjectId: uuid.optional(),
    chapterId: uuid.optional(),
    lessonId: uuid.optional(),
    topicId: uuid.optional(),
    kind: z.enum(["NORMAL_MCQ", "CASE_MCQ"]).optional(),
    difficulty: z.enum(["FOUNDATION", "INTERMEDIATE", "ADVANCED"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    academyId: uuid.optional(),
  }).parse(req.query);
  const questions = await import("../services/questionService.js");
  res.json(await questions.listStudentQuestions(req.auth!.userId, query.academyId, query));
}));
