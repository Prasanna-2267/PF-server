import { Router } from "express";
import { z } from "zod";
import { badRequest } from "../errors/api-error.js";
import { requirePermission } from "../auth/authorization.js";
import { asyncRoute } from "../middleware/async-route.js";
import * as adminService from "../services/adminService.js";
import * as adminCourseService from "../services/adminCourseService.js";
import { createContentRouter } from "./contentRoutes.js";
import { createQuestionRouter } from "./questionRoutes.js";
import { adminDomainRouter } from "./adminDomainRoutes.js";
import { adminBroadcastRouter } from "./adminBroadcastRoutes.js";
import * as studentGovernance from "../services/studentGovernanceService.js";
import * as superAdmins from "../services/superAdminManagementService.js";

const id = z.string().uuid();
const page = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) });
export const adminRouter = Router();
adminRouter.use("/content", createContentRouter("admin"));
adminRouter.use("/questions", createQuestionRouter("admin"));
adminRouter.use(adminDomainRouter);
adminRouter.use("/broadcasts", adminBroadcastRouter);
adminRouter.get("/overview", requirePermission("overview:read"), asyncRoute(async (req, res) => { const courseId = req.query.courseId ? id.parse(req.query.courseId) : undefined; res.json(await adminService.getAdminOverview(courseId)); }));
adminRouter.get("/super-admins", requirePermission("accounts:manage"), asyncRoute(async (_req, res) => { res.json({ items: await superAdmins.listSuperAdmins() }); }));
adminRouter.post("/super-admins", requirePermission("accounts:manage"), asyncRoute(async (req, res) => { const body = z.object({ fullName: z.string().trim().min(2).max(120), email: z.string().trim().email().max(320), password: z.string().min(12).max(128) }).strict().parse(req.body); res.status(201).json(await superAdmins.createSuperAdmin(req.auth!.userId, body)); }));
adminRouter.delete("/super-admins/:userId", requirePermission("accounts:manage"), asyncRoute(async (req, res) => { const body = z.object({ confirmation: z.literal("DELETE SUPER ADMIN") }).strict().parse(req.body); void body; res.json(await superAdmins.deleteSuperAdmin(req.auth!.userId, id.parse(req.params.userId))); }));

// Course CRUD Routes
adminRouter.get("/courses", asyncRoute(async (req, res) => {
  const query = page.extend({ search: z.string().trim().max(120).optional(), status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]).optional() }).parse(req.query);
  res.json(await adminCourseService.listAdminCourses(query));
}));
adminRouter.get("/courses/summary", asyncRoute(async (req, res) => {
  res.json(await adminCourseService.getAdminCoursesSummary());
}));
adminRouter.post("/courses", asyncRoute(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(160), code: z.string().trim().max(16).optional(), description: z.string().trim().max(2000).optional(), status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]).optional() }).strict().parse(req.body);
  res.status(201).json(await adminCourseService.createAdminCourse(body));
}));
adminRouter.get("/courses/:courseId", asyncRoute(async (req, res) => {
  res.json(await adminCourseService.getAdminCourse(id.parse(req.params.courseId)));
}));
adminRouter.patch("/courses/:courseId", asyncRoute(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(160).optional(), code: z.string().trim().min(1).max(16).optional(), description: z.string().trim().max(2000).optional(), status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]).optional() }).strict().refine((val) => Object.keys(val).length > 0).parse(req.body);
  res.json(await adminCourseService.updateAdminCourse(id.parse(req.params.courseId), body));
}));
adminRouter.delete("/courses/:courseId", asyncRoute(async (req, res) => {
  res.json(await adminCourseService.deleteAdminCourse(id.parse(req.params.courseId)));
}));
adminRouter.get("/students", requirePermission("students:read"), asyncRoute(async (req, res) => {
  const query = page.extend({ search: z.string().trim().max(120).optional(), status: z.enum(["ACTIVE", "DISABLED"]).optional(), role: z.string().trim().max(80).optional(), courseId: z.string().uuid().optional() }).parse(req.query);
  res.json(await adminService.listAdminUsers(query));
}));
adminRouter.get("/students/:userId", requirePermission("students:read"), asyncRoute(async (req, res) => { res.json(await adminService.getAdminUser(id.parse(req.params.userId))); }));
adminRouter.patch("/students/:userId/role", requirePermission("students:manage"), asyncRoute(async (req, res) => { const body = z.object({ role: z.string().trim().min(1).max(80) }).strict().parse(req.body); res.json(await adminService.updateAdminUserRole(req.auth!.userId, id.parse(req.params.userId), body.role)); }));
adminRouter.patch("/students/:userId/status", requirePermission("students:manage"), asyncRoute(async (req, res) => { const body = z.object({ status: z.enum(["ACTIVE", "DISABLED"]) }).strict().parse(req.body); res.json(await studentGovernance.setStudentAccountStatus(req.auth!.userId, id.parse(req.params.userId), body.status)); }));
adminRouter.post("/students/:userId/sessions/revoke", requirePermission("sessions:revoke"), asyncRoute(async (req, res) => { res.json(await adminService.revokeAdminUserSessions(req.auth!.userId, id.parse(req.params.userId))); }));
adminRouter.post("/students/:userId/device-reset/approve", requirePermission("students:manage"), asyncRoute(async (req, res) => { res.json(await studentGovernance.approveStudentDeviceReset(req.auth!.userId, id.parse(req.params.userId))); }));
adminRouter.delete("/students/:userId", requirePermission("students:manage"), asyncRoute(async (req, res) => { const body = z.object({ confirmation: z.literal("PERMANENTLY DELETE") }).strict().parse(req.body); void body; res.json(await studentGovernance.permanentlyDeleteStudent(req.auth!.userId, id.parse(req.params.userId))); }));
adminRouter.get("/orders", requirePermission("orders:read"), asyncRoute(async (req, res) => { const query = page.extend({ search: z.string().trim().max(120).optional(), status: z.enum(["CREATED", "PAID", "FAILED", "REFUNDED", "CANCELLED"]).optional() }).parse(req.query); res.json(await adminService.listAdminOrders(query)); }));
adminRouter.get("/orders/:orderId", requirePermission("orders:read"), asyncRoute(async (req, res) => { res.json(await adminService.getAdminOrder(id.parse(req.params.orderId))); }));
adminRouter.post("/orders/:orderId/refund", requirePermission("orders:manage"), asyncRoute(async (req, res) => { const key = req.get("idempotency-key")?.trim(); if (!key || key.length > 200) throw badRequest("IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required."); const body = z.object({ amount: z.number().positive().multipleOf(0.01), reason: z.string().trim().min(3).max(500) }).strict().parse(req.body); res.json(await adminService.refundAdminOrder(req.auth!.userId, id.parse(req.params.orderId), { ...body, idempotencyKey: key })); }));
adminRouter.post("/orders/:orderId/cancel", requirePermission("orders:manage"), asyncRoute(async (req, res) => { const body = z.object({ reason: z.string().trim().min(3).max(500) }).strict().parse(req.body); res.json(await adminService.cancelAdminOrder(req.auth!.userId, id.parse(req.params.orderId), body.reason)); }));
adminRouter.get("/audit", requirePermission("audit:read"), asyncRoute(async (req, res) => { const query = page.extend({ cursor: id.optional(), actorId: id.optional(), academyId: id.optional(), action: z.string().trim().max(100).optional(), entityType: z.string().trim().max(100).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }).parse(req.query); res.json(await adminService.listAuditEvents(query)); }));
adminRouter.get("/security-events", requirePermission("security:read"), asyncRoute(async (req, res) => { const query = page.extend({ cursor: id.optional(), riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(), eventType: z.enum(["LOGIN_SUCCESS", "LOGIN_FAILED", "LOGOUT", "SESSION_CREATED", "SESSION_REVOKED", "PASSWORD_CHANGED", "ACCOUNT_DISABLED", "ACCOUNT_ENABLED", "SUSPICIOUS_ACTIVITY", "QR_AUTH_SUCCESS", "QR_AUTH_FAILED"]).optional(), academyId: id.optional() }).parse(req.query); res.json(await adminService.listSecurityEvents(query)); }));
