import { Router } from "express";
import { z } from "zod";
import { asyncRoute } from "../middleware/async-route.js";
import * as settingsService from "../services/academySettingsService.js";

export const academySettingsRouter = Router();
const phone = z.string().trim().regex(/^[+\d][\d\s()-]{6,20}$/);
const website = z.union([z.literal(""), z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "Only HTTP(S) URLs are allowed.")]);
const settingsSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(), email: z.email().max(254).optional(), phone: phone.optional(),
  address: z.string().trim().min(1).max(500).optional(), city: z.string().trim().min(1).max(100).optional(),
  state: z.string().trim().min(1).max(100).optional(), country: z.string().trim().min(1).max(100).optional(),
  postalCode: z.string().trim().min(2).max(20).optional(), website: website.optional(), description: z.string().trim().max(2_000).optional(),
  adminName: z.string().trim().min(2).max(120).optional(), adminEmail: z.email().max(254).optional(), adminPhone: z.union([z.literal(""), phone]).optional(),
  expectedUpdatedAt: z.iso.datetime().optional(),
}).strict().refine((body) => Object.keys(body).some((key) => key !== "expectedUpdatedAt"), "At least one settings field is required.");
academySettingsRouter.get("/", asyncRoute(async (req, res) => {
  res.json(await settingsService.getAcademySettings(req.tenantContext!));
}));
academySettingsRouter.patch("/", asyncRoute(async (req, res) => {
  res.json(await settingsService.updateAcademySettings(req.tenantContext!, settingsSchema.parse(req.body)));
}));
academySettingsRouter.post("/logo/upload-intent", asyncRoute(async (req, res) => {
  const body = z.object({ fileName: z.string().trim().min(1).max(180), mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]), sizeBytes: z.number().int().positive().max(5 * 1024 * 1024), checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i) }).strict().parse(req.body);
  res.status(201).json(await settingsService.createAcademyLogoUpload(req.tenantContext!, body));
}));
academySettingsRouter.post("/logo", asyncRoute(async (req, res) => {
  const body = z.object({ uploadId: z.string().uuid() }).strict().parse(req.body);
  res.json(await settingsService.finalizeAcademyLogo(req.tenantContext!, body.uploadId));
}));
academySettingsRouter.get("/logo", asyncRoute(async (req, res) => {
  res.json(await settingsService.getAcademyLogoUrl(req.tenantContext!));
}));
