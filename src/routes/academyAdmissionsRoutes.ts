import { Router } from "express";
import { z } from "zod";
import { asyncRoute } from "../middleware/async-route.js";
import * as admissionsService from "../services/academyAdmissionsService.js";

export const academyAdmissionsRouter = Router();
const importRowSchema = z.object({ sNo: z.union([z.string().max(30), z.number()]).optional(), name: z.string().trim().min(1).max(100), email: z.email().max(254), phone: z.string().trim().max(30).optional() }).strict();
const importRowsSchema = z.array(importRowSchema).max(1_000);
const confirmImportSchema = z.object({ fileName: z.string().trim().min(1).max(255), rows: importRowsSchema }).strict();
const emptyBodySchema = z.object({}).strict();
const admissionCodeSchema = z.object({
  maxUses: z.number().int().min(1).max(100_000).nullable().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
}).strict();
academyAdmissionsRouter.get("/", asyncRoute(async (req, res) => {
  res.json(await admissionsService.getAdmissionsDashboard(req.tenantContext!));
}));
academyAdmissionsRouter.post("/import/validate", asyncRoute(async (req, res) => {
  const body = z.object({ rows: importRowsSchema }).strict().parse(req.body);
  res.json(await admissionsService.validateBulkImport(req.tenantContext!, body.rows));
}));
academyAdmissionsRouter.post("/import/confirm", asyncRoute(async (req, res) => {
  res.status(201).json(await admissionsService.confirmBulkImport(req.tenantContext!, confirmImportSchema.parse(req.body)));
}));
academyAdmissionsRouter.post("/bulk-import", asyncRoute(async (req, res) => {
  res.status(201).json(await admissionsService.confirmBulkImport(req.tenantContext!, confirmImportSchema.parse(req.body)));
}));
academyAdmissionsRouter.get("/imports", asyncRoute(async (req, res) => {
  res.json(await admissionsService.getImportBatches(req.tenantContext!));
}));
academyAdmissionsRouter.get("/imports/:batchId", asyncRoute(async (req, res) => {
  res.json(await admissionsService.getImportBatchDetail(req.tenantContext!, z.string().uuid().parse(req.params.batchId)));
}));
academyAdmissionsRouter.post("/qr/session", asyncRoute(async (req, res) => {
  emptyBodySchema.parse(req.body);
  res.status(201).json(await admissionsService.generateQrSession(req.tenantContext!));
}));
academyAdmissionsRouter.post("/qr", asyncRoute(async (req, res) => {
  emptyBodySchema.parse(req.body);
  res.status(201).json(await admissionsService.generateQrSession(req.tenantContext!));
}));
academyAdmissionsRouter.get("/codes", asyncRoute(async (req, res) => {
  res.json(await admissionsService.getAdmissionCodes(req.tenantContext!));
}));
academyAdmissionsRouter.post("/codes", asyncRoute(async (req, res) => {
  res.status(201).json(await admissionsService.createAdmissionCode(req.tenantContext!, admissionCodeSchema.parse(req.body)));
}));
academyAdmissionsRouter.post("/code", asyncRoute(async (req, res) => {
  res.status(201).json(await admissionsService.createAdmissionCode(req.tenantContext!, admissionCodeSchema.parse(req.body)));
}));
const updateAdmissionCodeSchema = z.object({
  maxUses: z.number().int().min(1).max(100_000).nullable().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
  status: z.enum(["ACTIVE", "REVOKED", "EXPIRED", "EXHAUSTED"]).optional(),
}).strict();

academyAdmissionsRouter.patch("/codes/:codeId", asyncRoute(async (req, res) => {
  res.json(await admissionsService.updateAdmissionCode(req.tenantContext!, z.string().uuid().parse(req.params.codeId), updateAdmissionCodeSchema.parse(req.body)));
}));
academyAdmissionsRouter.delete("/codes/:codeId", asyncRoute(async (req, res) => {
  res.json(await admissionsService.deleteAdmissionCode(req.tenantContext!, z.string().uuid().parse(req.params.codeId)));
}));
academyAdmissionsRouter.patch("/codes/:codeId/revoke", asyncRoute(async (req, res) => {
  res.json(await admissionsService.revokeAdmissionCode(req.tenantContext!, z.string().uuid().parse(req.params.codeId)));
}));

export const studentAdmissionsRouter = Router();
studentAdmissionsRouter.post("/qr/claim", asyncRoute(async (req, res) => {
  const body = z.object({ qrToken: z.string().min(20).max(512) }).strict().parse(req.body);
  res.json(await admissionsService.claimQrSession(req.auth!.userId, body.qrToken));
}));
studentAdmissionsRouter.post("/codes/claim", asyncRoute(async (req, res) => {
  const body = z.object({ code: z.string().trim().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/i) }).strict().parse(req.body);
  res.json(await admissionsService.claimAdmissionCode(req.auth!.userId, body.code));
}));
