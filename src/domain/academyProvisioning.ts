import { z } from "zod";

const optionalText = (max: number) => z.string().trim().max(max).optional();
const phone = z.string().trim().regex(/^\+?[0-9][0-9\s()-]{6,19}$/, "Enter a valid mobile number.");
const optionalUrl = z.union([z.literal(""), z.url()]).optional();
const address = z.object({
  addressLine1: z.string().trim().min(2).max(240),
  addressLine2: optionalText(240),
  city: z.string().trim().min(2).max(100),
  state: z.string().trim().min(2).max(100),
  country: z.string().trim().min(2).max(100).default("India"),
  postalCode: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 -]{2,11}$/, "Enter a valid postal code."),
}).strict();

export const legacyAcademySchema = z.object({
  slug: z.string().trim().min(2).max(80).optional(), name: z.string().trim().min(2).max(120),
  email: z.email(), phone, address: z.string().trim().min(1).max(500), city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(100), country: z.string().trim().min(1).max(100).optional(),
  postalCode: z.string().trim().min(2).max(20), website: optionalUrl, description: optionalText(2_000),
  adminName: z.string().trim().min(2).max(120), adminEmail: z.email(), adminPhone: phone.optional(),
}).strict();

export const academyProvisioningSchema = z.object({
  requestKey: z.string().trim().min(12).max(120),
  academy: z.object({
    name: z.string().trim().min(2).max(120), displayName: z.string().trim().min(2).max(120),
    type: z.string().trim().min(1).max(120),
    email: z.email(), phone, website: optionalUrl, description: optionalText(2_000),
    establishedYear: z.number().int().min(1800).max(new Date().getUTCFullYear()).optional(),
    socialLinks: z.record(z.string(), z.url()).optional(), logoUploadId: z.uuid().optional(),
  }).strict(),
  primaryAdmin: z.object({ fullName: z.string().trim().min(2).max(120), email: z.email(), mobile: phone }).strict(),
  contacts: z.array(z.object({ role: z.string().trim().min(1).max(120), fullName: z.string().trim().min(2).max(120), email: z.email().optional(), phone: phone.optional() }).strict()).max(20).default([]),
  legal: z.object({
    legalName: optionalText(180), entityType: z.string().trim().min(1).max(120),
    panStatus: z.string().trim().min(1).max(120), pan: z.string().trim().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/).optional(),
    tan: z.string().trim().regex(/^[A-Z]{4}[0-9]{5}[A-Z]$/).optional(), gstStatus: z.string().trim().min(1).max(120),
    gstin: z.string().trim().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/).optional(), gstState: optionalText(100),
    gstRegistrationType: optionalText(120), gstRegistrationDate: z.iso.date().optional(),
    gstCertificateUploadId: z.uuid().optional(), placeOfSupply: optionalText(100),
  }).strict().superRefine((value, ctx) => {
    if (value.gstStatus === "YES" && !value.gstin) ctx.addIssue({ code: "custom", path: ["gstin"], message: "GSTIN is required for a GST-registered academy." });
    if (value.gstStatus === "YES" && !value.gstState) ctx.addIssue({ code: "custom", path: ["gstState"], message: "GST registration state is required." });
    if (value.gstStatus !== "YES" && value.gstin) ctx.addIssue({ code: "custom", path: ["gstin"], message: "Remove GSTIN unless GST status is Yes." });
    if (value.panStatus === "AVAILABLE" && !value.pan) ctx.addIssue({ code: "custom", path: ["pan"], message: "PAN is required when marked available." });
  }),
  addresses: z.object({ academy: address, billingSameAsAcademy: z.boolean(), billing: address.optional() }).strict().superRefine((value, ctx) => {
    if (!value.billingSameAsAcademy && !value.billing) ctx.addIssue({ code: "custom", path: ["billing"], message: "Billing address is required." });
  }),
  billing: z.object({ invoiceDisplayName: optionalText(180), invoiceEmail: z.email().optional(), billingContactName: optionalText(120), billingContactPhone: phone.optional(), purchaseOrderRequired: z.boolean().default(false), currency: z.string().trim().length(3).default("INR") }).strict(),
  academic: z.object({ categories: z.array(z.string().trim().min(1).max(80)).min(1).max(30), programs: z.array(z.string().trim().min(1).max(120)).max(100).default([]), initialBranch: optionalText(120), initialBatch: optionalText(120) }).strict(),
  commercial: z.object({ planKey: z.string().trim().min(1).max(80), subscriptionStatus: z.string().trim().min(1).max(120), startDate: z.iso.date(), endDate: z.iso.date().optional(), studentSeatLimit: z.number().int().min(1).max(1_000_000), billingCycle: z.string().trim().min(1).max(120).default("ANNUAL") }).strict().superRefine((value, ctx) => {
    if (value.endDate && value.endDate < value.startDate) ctx.addIssue({ code: "custom", path: ["endDate"], message: "Subscription end date must follow the start date." });
  }),
}).strict();

export const academyCreateSchema = z.union([academyProvisioningSchema, legacyAcademySchema]);
export type AcademyProvisioningInput = z.infer<typeof academyProvisioningSchema>;
export type LegacyAcademyInput = z.infer<typeof legacyAcademySchema>;
