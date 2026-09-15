import { Router } from "express";
import { z } from "zod";
import { createRateLimiter } from "../middleware/rate-limit.js";
import { asyncRoute } from "../middleware/async-route.js";
import * as publicService from "../services/publicService.js";
import { computeCollectionProducts } from "../services/merchandisingService.js";
import { requireAuth } from "../auth/auth-middleware.js";

const uuid = z.string().uuid();
export const catalogRouter = Router();
const sendCatalogImage = async (res: any, image: { url: string; mimeType?: string }) => {
  const upstream = await fetch(image.url);
  if (!upstream.ok) {
    res.status(502).json({ error: { code: "CATALOG_PREVIEW_FETCH_FAILED", message: "The content preview could not be loaded." } });
    return;
  }
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.set("Cache-Control", "private, max-age=300");
  res.type(image.mimeType || upstream.headers.get("content-type") || "application/octet-stream");
  res.send(buffer);
};
catalogRouter.get("/", asyncRoute(async (req, res) => { const query = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25), search: z.string().trim().max(120).optional(), academyId: uuid.optional() }).parse(req.query); res.json(await publicService.listCatalog(query)); }));
catalogRouter.get("/courses/:courseId", asyncRoute(async (req, res) => { res.json(await publicService.getCatalogCourse(uuid.parse(req.params.courseId))); }));
catalogRouter.get("/packages/:packageId", asyncRoute(async (req, res) => { res.json(await publicService.getCatalogPackage(uuid.parse(req.params.packageId))); }));
catalogRouter.get("/question-banks/:questionBankId", asyncRoute(async (req, res) => { res.json(await publicService.getCatalogQuestionBank(uuid.parse(req.params.questionBankId))); }));
catalogRouter.get("/content/:contentId/cover", asyncRoute(async (req, res) => {
  const cover = await publicService.getCatalogContentCover(uuid.parse(req.params.contentId));
  await sendCatalogImage(res, cover);
}));
catalogRouter.get("/content/:contentId/previews/:imageId", asyncRoute(async (req, res) => {
  const image = await publicService.getCatalogContentPreviewImage(uuid.parse(req.params.contentId), uuid.parse(req.params.imageId));
  await sendCatalogImage(res, image);
}));
catalogRouter.get("/content/:contentId", asyncRoute(async (req, res) => { res.json(await publicService.getCatalogContent(uuid.parse(req.params.contentId))); }));
catalogRouter.get("/collections/:key", asyncRoute(async (req: any, res) => {
  const key = z.string().trim().parse(req.params.key);
  const courseSlug = typeof req.query.courseSlug === "string" ? req.query.courseSlug : "all";
  const studentUserId = req.actorId;
  res.json(await computeCollectionProducts(key, courseSlug, studentUserId));
}));

catalogRouter.get("/user-courses", requireAuth, asyncRoute(async (req, res) => {
  const student = await publicService.getStudentUserCourses(req.auth!.userId);
  res.json({ courses: student });
}));

export const contactRouter = Router();
contactRouter.use(createRateLimiter({ windowMs: 60 * 60_000, maxRequests: 5, namespace: "contact" }));
contactRouter.post("/", asyncRoute(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(2).max(120), email: z.email().max(254), phone: z.string().trim().min(7).max(30).optional(), subject: z.string().trim().min(2).max(180), message: z.string().trim().min(10).max(10_000), academyId: uuid.optional(), website: z.string().max(500).optional() }).strict().parse(req.body);
  if (body.website) { res.status(202).json({ status: "RECEIVED" }); return; }
  res.status(202).json(await publicService.submitContact({ ...body, ipAddress: req.ip }));
}));
