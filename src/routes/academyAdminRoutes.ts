import { Router, raw } from "express";
import { z } from "zod";
import { requireAcademyAdminMiddleware } from "../auth/tenant-auth.js";
import { asyncRoute } from "../middleware/async-route.js";
import * as academyService from "../services/academyAdminService.js";
import { academyAdmissionsRouter } from "./academyAdmissionsRoutes.js";
import { createContentRouter } from "./contentRoutes.js";
import { createQuestionRouter } from "./questionRoutes.js";
import { academySettingsRouter } from "./academySettingsRoutes.js";
import * as broadcastMedia from "../services/broadcastMediaService.js";
import * as studentGovernance from "../services/studentGovernanceService.js";
import * as adminDomainService from "../services/adminDomainService.js";

export const academyAdminRouter = Router();
academyAdminRouter.use(requireAcademyAdminMiddleware);

const idSchema = z.string().uuid();
const paginationSchema = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) });
const courseQuerySchema = paginationSchema.extend({ includeArchived: z.coerce.boolean().default(false), search: z.string().trim().max(120).optional(), status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]).optional(), sort: z.enum(["newest", "oldest", "name_asc", "name_desc"]).default("newest") });
const studentQuerySchema = paginationSchema.extend({ search: z.string().trim().max(120).optional(), status: z.enum(["ACTIVE", "INVITED", "SUSPENDED", "REVOKED"]).optional(), accountStatus: z.enum(["ACTIVE", "DISABLED"]).optional() });
const broadcastQuerySchema = paginationSchema.extend({ search: z.string().trim().max(120).optional(), status: z.enum(["DRAFT", "SCHEDULED", "ACTIVE", "EXPIRED", "ARCHIVED", "DISABLED"]).optional(), type: z.enum(["ANNOUNCEMENT", "IMPORTANT_NOTICE", "UPDATE", "MAINTENANCE", "FEATURE_UPDATE", "ACADEMIC", "GENERAL", "CRITICAL_ALERT"]).optional() });
const invitationSchema = z.object({ email: z.email().max(254), studentName: z.string().trim().min(2).max(120).optional() }).strict();
const courseCreateSchema = z.object({ name: z.string().trim().min(2).max(120), code: z.string().trim().regex(/^[A-Za-z0-9_-]{2,16}$/), description: z.string().trim().max(2_000).optional(), status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]).default("ACTIVE") }).strict();
const courseUpdateSchema = courseCreateSchema.partial().strict().refine((body) => Object.keys(body).length > 0, "At least one field is required.");
const broadcastCtaSchema = z.object({ enabled: z.boolean(), text: z.string().trim().max(80), action: z.enum(["INTERNAL_ROUTE", "EXTERNAL_URL", "COURSE", "CONTENT"]), destination: z.string().trim().max(500) }).strict();
const broadcastSchema = z.object({
  title: z.string().trim().min(2).max(160), subtitle: z.string().trim().max(240).optional(), message: z.string().trim().min(1).max(10_000),
  type: z.enum(["ANNOUNCEMENT", "IMPORTANT_NOTICE", "UPDATE", "MAINTENANCE", "FEATURE_UPDATE", "ACADEMIC", "GENERAL", "CRITICAL_ALERT"]).optional(), priority: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).optional(),
  targetCourseId: z.string().uuid().nullable().optional(), startAt: z.iso.datetime().optional(), endAt: z.iso.datetime().optional(),
  platform: z.literal("APP").optional(), placements: z.array(z.enum(["NOTIFICATION", "HOME", "COURSE", "GENERAL"])).min(1).max(4).optional(),
  cta: broadcastCtaSchema.optional(), frequency: z.enum(["ONCE", "DAILY", "EVERY_VISIT", "UNTIL_DISMISSED", "ALWAYS_ACTIVE"]).optional(),
  dismissible: z.boolean().optional(), presentation: z.enum(["BANNER", "NOTIFICATION", "CARD", "MODAL", "WHATS_NEW", "CRITICAL_ALERT"]).optional(),
  displayOrder: z.enum(["AUTOMATIC", "PINNED", "CUSTOM"]).optional(), customOrderWeight: z.number().int().min(1).max(100).optional(), acknowledgementRequired: z.boolean().optional(),
  repeatBehavior: z.enum(["NEVER", "INTERVAL", "CONTINUE"]).optional(), showInWhatsNew: z.boolean().optional(),
}).strict();
const broadcastUpdateSchema = broadcastSchema.partial().extend({ startAt: z.union([z.iso.datetime(), z.null()]).optional(), endAt: z.union([z.iso.datetime(), z.null()]).optional() }).strict().refine((body) => Object.keys(body).length > 0, "At least one field is required.");

academyAdminRouter.get("/context", (req, res) => {
  const context = req.tenantContext!;
  res.json({
    academyId: context.academyId,
    roleInAcademy: context.roleInAcademy,
    membershipId: context.membershipId,
    permissions: [...context.permissions].sort(),
  });
});

academyAdminRouter.use("/content", createContentRouter("academy"));
academyAdminRouter.use("/questions", createQuestionRouter("academy"));
academyAdminRouter.use("/admissions", academyAdmissionsRouter);
academyAdminRouter.use("/settings", academySettingsRouter);

academyAdminRouter.get("/overview", asyncRoute(async (req, res) => {
  res.json(await academyService.getAcademyOverview(req.tenantContext!));
}));
academyAdminRouter.get("/students", asyncRoute(async (req, res) => {
  res.json(await academyService.getAcademyStudents(req.tenantContext!, studentQuerySchema.parse(req.query)));
}));
academyAdminRouter.get("/students/:studentId", asyncRoute(async (req, res) => {
  res.json(await academyService.getAcademyStudentDetail(req.tenantContext!, idSchema.parse(req.params.studentId)));
}));
academyAdminRouter.post("/students/invite", asyncRoute(async (req, res) => {
  res.status(201).json(await academyService.inviteAcademyStudent(req.tenantContext!, invitationSchema.parse(req.body)));
}));
academyAdminRouter.patch("/students/:studentId/status", asyncRoute(async (req, res) => {
  const body = z.object({ status: z.enum(["ACTIVE", "SUSPENDED", "REVOKED"]) }).strict().parse(req.body);
  res.json(await academyService.updateAcademyStudentStatus(
    req.tenantContext!,
    idSchema.parse(req.params.studentId),
    body.status,
  ));
}));
academyAdminRouter.post("/students/:studentId/enrollments", asyncRoute(async (req, res) => {
  const body = z.object({ courseId: z.string().uuid() }).strict().parse(req.body);
  res.status(201).json(await academyService.enrollStudentInCourse(
    req.tenantContext!,
    idSchema.parse(req.params.studentId),
    body.courseId,
  ));
}));

academyAdminRouter.get("/courses", asyncRoute(async (req, res) => {
  res.json(await academyService.getAcademyCourses(req.tenantContext!, courseQuerySchema.parse(req.query)));
}));
academyAdminRouter.get("/courses/:courseId", asyncRoute(async (req, res) => {
  res.json(await academyService.getAcademyCourseDetail(req.tenantContext!, idSchema.parse(req.params.courseId)));
}));
academyAdminRouter.post("/courses", asyncRoute(async (req, res) => {
  res.status(201).json(await academyService.createAcademyCourse(req.tenantContext!, courseCreateSchema.parse(req.body)));
}));
academyAdminRouter.patch("/courses/:courseId", asyncRoute(async (req, res) => {
  res.json(await academyService.updateAcademyCourse(req.tenantContext!, idSchema.parse(req.params.courseId), courseUpdateSchema.parse(req.body)));
}));
academyAdminRouter.delete("/courses/:courseId", asyncRoute(async (req, res) => {
  res.json(await academyService.archiveAcademyCourse(req.tenantContext!, idSchema.parse(req.params.courseId)));
}));
academyAdminRouter.post("/courses/:courseId/restore", asyncRoute(async (req, res) => {
  res.json(await academyService.restoreAcademyCourse(req.tenantContext!, idSchema.parse(req.params.courseId)));
}));

academyAdminRouter.get("/broadcasts", asyncRoute(async (req, res) => {
  res.json(await academyService.getAcademyBroadcasts(req.tenantContext!, broadcastQuerySchema.parse(req.query)));
}));
academyAdminRouter.post("/broadcasts", asyncRoute(async (req, res) => {
  res.status(201).json(await academyService.createAcademyBroadcast(req.tenantContext!, broadcastSchema.parse(req.body)));
}));
academyAdminRouter.post("/broadcasts/:broadcastId/image/upload-intent", asyncRoute(async (req, res) => { const body = z.object({ fileName: z.string().trim().min(1).max(180), mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]), sizeBytes: z.number().int().positive().max(10 * 1024 * 1024), checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i) }).strict().parse(req.body); res.status(201).json(await broadcastMedia.createImageUpload({ academyId: req.tenantContext!.academyId!, actorId: req.auth!.userId }, idSchema.parse(req.params.broadcastId), body)); }));
academyAdminRouter.put("/broadcasts/:broadcastId/image/uploads/:uploadId", raw({ type: ["image/jpeg", "image/png", "image/webp", "image/gif"], limit: "10mb" }), asyncRoute(async (req, res) => {
  if (!Buffer.isBuffer(req.body)) throw new Error("Broadcast image body was not parsed as binary data.");
  res.json(await broadcastMedia.uploadImageBytes({ academyId: req.tenantContext!.academyId!, actorId: req.auth!.userId }, idSchema.parse(req.params.broadcastId), idSchema.parse(req.params.uploadId), req.body));
}));
academyAdminRouter.patch("/students/:studentId/account-status", asyncRoute(async (req, res) => {
  const body = z.object({ status: z.enum(["ACTIVE", "DISABLED"]) }).strict().parse(req.body);
  res.json(await studentGovernance.setStudentAccountStatus(req.auth!.userId, idSchema.parse(req.params.studentId), body.status, req.tenantContext!.academyId));
}));
academyAdminRouter.post("/students/:studentId/device-reset/approve", asyncRoute(async (req, res) => {
  res.json(await studentGovernance.approveStudentDeviceReset(req.auth!.userId, idSchema.parse(req.params.studentId), req.tenantContext!.academyId));
}));
academyAdminRouter.get("/students/:studentId/grant-access/catalog", asyncRoute(async (req, res) => {
  const query = z.object({ courseId: idSchema.optional() }).strict().parse(req.query);
  res.json(await adminDomainService.getStudentGrantAccessCatalog(idSchema.parse(req.params.studentId), query.courseId, req.tenantContext!.academyId!));
}));
academyAdminRouter.post("/students/:studentId/grant-access", asyncRoute(async (req, res) => {
  const body = z.object({
    courseId: idSchema,
    selections: z.object({ notes: z.array(idSchema).max(100), questionBanks: z.array(idSchema).max(100), bundles: z.array(idSchema).max(100), subscriptions: z.array(idSchema).max(100) }).strict(),
    expiresAt: z.iso.datetime().nullable().optional(),
  }).strict().parse(req.body);
  const result = await adminDomainService.grantStudentAccess(req.auth!.userId, idSchema.parse(req.params.studentId), body, req.tenantContext!.academyId!);
  res.status(201).json(result);
}));
academyAdminRouter.get("/students/:studentId/entitlements", asyncRoute(async (req, res) => {
  res.json(await adminDomainService.listAcademyStudentManualEntitlements(idSchema.parse(req.params.studentId), req.tenantContext!.academyId!));
}));
academyAdminRouter.post("/entitlements/:entitlementId/revoke", asyncRoute(async (req, res) => {
  const body = z.object({ reason: z.string().trim().min(3).max(500) }).strict().parse(req.body);
  res.json(await adminDomainService.revokeEntitlement(req.auth!.userId, idSchema.parse(req.params.entitlementId), body.reason, req.tenantContext!.academyId!));
}));
academyAdminRouter.delete("/students/:studentId", asyncRoute(async (req, res) => {
  const body = z.object({ confirmation: z.literal("PERMANENTLY DELETE") }).strict().parse(req.body); void body;
  res.json(await studentGovernance.permanentlyDeleteStudent(req.auth!.userId, idSchema.parse(req.params.studentId), req.tenantContext!.academyId));
}));
academyAdminRouter.post("/broadcasts/:broadcastId/image", asyncRoute(async (req, res) => { const body = z.object({ uploadId: idSchema }).strict().parse(req.body); res.json(await broadcastMedia.finalizeImage({ academyId: req.tenantContext!.academyId!, actorId: req.auth!.userId }, idSchema.parse(req.params.broadcastId), body.uploadId)); }));
academyAdminRouter.get("/broadcasts/:broadcastId/image", asyncRoute(async (req, res) => { res.json(await broadcastMedia.getImageUrl({ academyId: req.tenantContext!.academyId!, actorId: req.auth!.userId }, idSchema.parse(req.params.broadcastId))); }));
academyAdminRouter.delete("/broadcasts/:broadcastId/image", asyncRoute(async (req, res) => { res.json(await broadcastMedia.deleteImage({ academyId: req.tenantContext!.academyId!, actorId: req.auth!.userId }, idSchema.parse(req.params.broadcastId))); }));
academyAdminRouter.get("/broadcasts/:broadcastId", asyncRoute(async (req, res) => {
  res.json(await academyService.getAcademyBroadcastDetail(req.tenantContext!, idSchema.parse(req.params.broadcastId)));
}));
academyAdminRouter.patch("/broadcasts/:broadcastId", asyncRoute(async (req, res) => {
  res.json(await academyService.updateAcademyBroadcast(req.tenantContext!, idSchema.parse(req.params.broadcastId), broadcastUpdateSchema.parse(req.body)));
}));
academyAdminRouter.post("/broadcasts/:broadcastId/publish", asyncRoute(async (req, res) => {
  res.json(await academyService.publishAcademyBroadcast(req.tenantContext!, idSchema.parse(req.params.broadcastId)));
}));
academyAdminRouter.post("/broadcasts/:broadcastId/schedule", asyncRoute(async (req, res) => {
  const body = z.object({ startAt: z.iso.datetime() }).strict().parse(req.body);
  res.json(await academyService.scheduleAcademyBroadcast(req.tenantContext!, idSchema.parse(req.params.broadcastId), body.startAt));
}));
academyAdminRouter.post("/broadcasts/:broadcastId/cancel", asyncRoute(async (req, res) => {
  res.json(await academyService.cancelAcademyBroadcast(req.tenantContext!, idSchema.parse(req.params.broadcastId)));
}));
academyAdminRouter.post("/broadcasts/:broadcastId/archive", asyncRoute(async (req, res) => {
  res.json(await academyService.archiveAcademyBroadcast(req.tenantContext!, idSchema.parse(req.params.broadcastId)));
}));
academyAdminRouter.post("/broadcasts/:broadcastId/restore", asyncRoute(async (req, res) => {
  res.json(await academyService.restoreAcademyBroadcast(req.tenantContext!, idSchema.parse(req.params.broadcastId)));
}));
academyAdminRouter.delete("/broadcasts/:broadcastId", asyncRoute(async (req, res) => {
  res.json(await academyService.deleteAcademyBroadcast(req.tenantContext!, idSchema.parse(req.params.broadcastId)));
}));
