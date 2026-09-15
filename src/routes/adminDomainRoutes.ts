import { Router } from "express";
import { z } from "zod";
import { asyncRoute } from "../middleware/async-route.js";
import * as service from "../services/adminDomainService.js";
import { getMerchandisingSections, updateMerchandisingSection } from "../services/merchandisingService.js";
import { academyCreateSchema, legacyAcademySchema } from "../domain/academyProvisioning.js";
import { createOnboardingAssetIntent, finalizeOnboardingAsset } from "../services/academyProvisioningAssetService.js";

const uuid = z.string().uuid();
const page = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) });
const academy = legacyAcademySchema;

export const adminDomainRouter = Router();
adminDomainRouter.post("/academies/onboarding-assets/upload-intents", asyncRoute(async (req, res) => {
  const body = z.object({ kind: z.enum(["LOGO", "GST_CERTIFICATE"]), fileName: z.string().trim().min(1).max(240), mimeType: z.string().trim().min(3).max(120), sizeBytes: z.number().int().min(1), checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i) }).strict().parse(req.body);
  res.status(201).json(await createOnboardingAssetIntent(req.auth!.userId, body));
}));
adminDomainRouter.post("/academies/onboarding-assets/:uploadId/finalize", asyncRoute(async (req, res) => { res.json(await finalizeOnboardingAsset(req.auth!.userId, uuid.parse(req.params.uploadId))); }));
adminDomainRouter.get("/academies/summary", asyncRoute(async (req, res) => { res.json(await service.getAcademiesSummary()); }));
adminDomainRouter.get("/academies", asyncRoute(async (req, res) => { res.json(await service.listAcademies(page.extend({ search: z.string().trim().max(120).optional(), status: z.enum(["ACTIVE", "PENDING", "SUSPENDED", "ARCHIVED", "ALL"]).optional(), sort: z.enum(["newest", "oldest", "name-asc", "name-desc", "students", "courses"]).optional(), includeDeleted: z.coerce.boolean().optional() }).parse(req.query))); }));
adminDomainRouter.post("/academies", asyncRoute(async (req, res) => { res.status(201).json(await service.createAcademy(req.auth!.userId, academyCreateSchema.parse(req.body))); }));
for (const resource of ["students", "courses", "content", "questions", "broadcasts", "admissions", "audit"] as const) {
  adminDomainRouter.get(`/academies/:academyId/${resource}`, asyncRoute(async (req, res) => {
    res.json(await service.listAcademyDetailResource(uuid.parse(req.params.academyId), resource, page.parse(req.query)));
  }));
}
adminDomainRouter.get("/academies/:academyId", asyncRoute(async (req, res) => { res.json(await service.getAcademy(z.string().trim().min(1).parse(req.params.academyId))); }));
adminDomainRouter.patch("/academies/:academyId", asyncRoute(async (req, res) => { res.json(await service.updateAcademy(req.auth!.userId, z.string().trim().min(1).parse(req.params.academyId), academy.partial().refine((body) => Object.keys(body).length > 0).parse(req.body))); }));
for (const action of ["activate", "suspend", "archive", "restore", "delete"] as const) adminDomainRouter.post(`/academies/:academyId/${action}`, asyncRoute(async (req, res) => { res.json(await service.setAcademyLifecycle(req.auth!.userId, z.string().trim().min(1).parse(req.params.academyId), action)); }));
adminDomainRouter.post("/academies/:academyId/admins/invite", asyncRoute(async (req, res) => { const body = z.object({ email: z.email(), name: z.string().trim().min(2).max(120) }).strict().parse(req.body); res.status(201).json(await service.inviteAcademyAdmin(req.auth!.userId, z.string().trim().min(1).parse(req.params.academyId), body)); }));
adminDomainRouter.post("/academies/:academyId/admins/:userId/revoke", asyncRoute(async (req, res) => { const body = z.object({ reason: z.string().trim().min(3).max(500) }).strict().parse(req.body); res.json(await service.revokeAcademyAdmin(req.auth!.userId, z.string().trim().min(1).parse(req.params.academyId), uuid.parse(req.params.userId), body.reason)); }));

const packageInput = z.object({ courseId: uuid, title: z.string().trim().min(2).max(160), slug: z.string().trim().min(2).max(100).optional(), description: z.string().trim().max(5_000).optional(), price: z.number().min(0).max(9_999_999), accessDurationValue: z.number().int().positive().max(3650).nullable().optional(), accessDurationUnit: z.enum(["DAYS", "WEEKS", "MONTHS"]).nullable().optional(), status: z.enum(["DRAFT", "PUBLISHED"]).optional(), contentItemIds: z.array(uuid).max(1_000).optional(), questionBankIds: z.array(uuid).max(1_000).optional() }).strict();
adminDomainRouter.get("/packages", asyncRoute(async (req, res) => { res.json(await service.listPackages(page.extend({ courseId: uuid.optional(), status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).optional(), includeDeleted: z.coerce.boolean().optional(), search: z.string().trim().optional() }).parse(req.query))); }));
adminDomainRouter.post("/packages", asyncRoute(async (req, res) => { res.status(201).json(await service.createPackage(req.auth!.userId, packageInput.parse(req.body))); }));
adminDomainRouter.get("/packages/:packageId", asyncRoute(async (req, res) => { res.json(await service.getPackage(uuid.parse(req.params.packageId))); }));
adminDomainRouter.patch("/packages/:packageId", asyncRoute(async (req, res) => { const input = packageInput.omit({ courseId: true }).partial().extend({ status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).optional() }).refine((body) => Object.keys(body).length > 0).parse(req.body); res.json(await service.updatePackage(req.auth!.userId, uuid.parse(req.params.packageId), input)); }));
adminDomainRouter.delete("/packages/:packageId", asyncRoute(async (req, res) => { res.json(await service.archivePackage(req.auth!.userId, uuid.parse(req.params.packageId))); }));
adminDomainRouter.post("/packages/:packageId/restore", asyncRoute(async (req, res) => { res.json(await service.archivePackage(req.auth!.userId, uuid.parse(req.params.packageId), true)); }));

adminDomainRouter.get("/coupons", asyncRoute(async (req, res) => { res.json(await service.listCoupons(page.extend({ enabled: z.coerce.boolean().optional() }).parse(req.query))); }));
adminDomainRouter.post("/coupons", asyncRoute(async (req, res) => { const body = z.object({ code: z.string().trim().regex(/^[A-Za-z0-9_-]{3,40}$/), discountType: z.enum(["PERCENT", "FLAT"]), discountValue: z.number().positive(), scope: z.enum(["ALL", "PACKAGES", "SUBJECTS"]).optional(), maxUses: z.number().int().positive().optional(), expiresAt: z.iso.datetime().optional(), packageIds: z.array(uuid).max(1_000).optional(), subjectIds: z.array(uuid).max(1_000).optional() }).strict().parse(req.body); res.status(201).json(await service.createCoupon(req.auth!.userId, body)); }));
adminDomainRouter.patch("/coupons/:couponId", asyncRoute(async (req, res) => { const body = z.object({ enabled: z.boolean().optional(), maxUses: z.number().int().positive().nullable().optional(), expiresAt: z.iso.datetime().nullable().optional() }).strict().refine((value) => Object.keys(value).length > 0).parse(req.body); res.json(await service.updateCoupon(req.auth!.userId, uuid.parse(req.params.couponId), body)); }));

adminDomainRouter.get("/entitlements", asyncRoute(async (req, res) => { res.json(await service.listEntitlements(page.extend({ userId: uuid.optional(), status: z.enum(["ACTIVE", "EXPIRED", "REVOKED"]).optional(), source: z.enum(["PURCHASE", "ADMIN_GRANT", "SUBSCRIPTION", "PROMOTION"]).optional() }).parse(req.query))); }));
adminDomainRouter.get("/students/:userId/grant-access/catalog", asyncRoute(async (req, res) => {
  const query = z.object({ courseId: uuid.optional() }).strict().parse(req.query);
  res.json(await service.getStudentGrantAccessCatalog(uuid.parse(req.params.userId), query.courseId));
}));
adminDomainRouter.post("/students/:userId/grant-access", asyncRoute(async (req, res) => {
  const body = z.object({
    courseId: uuid,
    selections: z.object({
      notes: z.array(uuid).max(100),
      questionBanks: z.array(uuid).max(100),
      bundles: z.array(uuid).max(100),
      subscriptions: z.array(uuid).max(100),
    }).strict(),
    expiresAt: z.iso.datetime().nullable().optional(),
  }).strict().parse(req.body);
  res.status(201).json(await service.grantStudentAccess(req.auth!.userId, uuid.parse(req.params.userId), body));
}));
adminDomainRouter.get("/entitlement-resources", asyncRoute(async (req, res) => {
  const query = z.object({
    resourceType: z.enum(["COURSE", "PACKAGE", "QUESTION_BANK", "LESSON", "PREMIUM_NOTES", "SUBJECT", "OTHER"]),
    search: z.string().trim().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }).parse(req.query);
  res.json(await service.listEntitlementResources(query));
}));
adminDomainRouter.post("/entitlements/:entitlementId/revoke", asyncRoute(async (req, res) => { const body = z.object({ reason: z.string().trim().min(3).max(500) }).strict().parse(req.body); res.json(await service.revokeEntitlement(req.auth!.userId, uuid.parse(req.params.entitlementId), body.reason)); }));

adminDomainRouter.get("/store-management/sections", asyncRoute(async (req, res) => {
  const sections = await getMerchandisingSections();
  const kpis = await service.getStoreKpis();
  res.json({ sections, kpis });
}));

adminDomainRouter.patch("/store-management/sections/:key", asyncRoute(async (req, res) => {
  const key = z.string().trim().parse(req.params.key);
  const input = z.object({
    title: z.string().trim().optional(),
    subtitle: z.string().trim().optional(),
    mode: z.enum(["AUTO", "HYBRID", "MANUAL"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    dateWindowDays: z.number().int().min(1).max(365).nullable().optional(),
    pinnedItemIds: z.array(z.string()).optional(),
    excludedItemIds: z.array(z.string()).optional(),
    isEnabled: z.boolean().optional(),
  }).parse(req.body);

  res.json(await updateMerchandisingSection(key, input));
}));
