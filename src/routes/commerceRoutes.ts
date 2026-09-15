import { Router } from "express";
import { z } from "zod";
import { badRequest } from "../errors/api-error.js";
import { asyncRoute } from "../middleware/async-route.js";
import * as commerce from "../services/commerceService.js";

export const checkoutRouter = Router();
const idempotencyKey = (value: string | undefined) => {
  const key = value?.trim();
  if (!key || key.length > 200) throw badRequest("IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required.");
  return key;
};

const checkoutItemSchema = z.object({
  resourceType: z.enum(["PACKAGE", "CONTENT", "QUESTION_BANK"]),
  resourceId: z.string().uuid(),
}).strict();

checkoutRouter.post("/", asyncRoute(async (req, res) => {
  const body = z.object({
    // packageIds remains supported for the existing Admin/web clients.
    packageIds: z.array(z.string().uuid()).min(1).max(50).optional(),
    items: z.array(checkoutItemSchema).min(1).max(50).optional(),
    couponCode: z.string().trim().max(40).optional(),
  }).strict().superRefine((value, context) => {
    if (!value.packageIds?.length && !value.items?.length) context.addIssue({ code: "custom", path: ["items"], message: "At least one checkout item is required." });
  }).parse(req.body);
  res.status(201).json(await commerce.createCheckout(req.auth!.userId, body, idempotencyKey(req.get("idempotency-key"))));
}));

checkoutRouter.post("/:orderId/fake-payment", asyncRoute(async (req, res) => {
  const orderId = z.string().uuid().parse(req.params.orderId);
  z.object({ outcome: z.literal("SUCCESS") }).strict().parse(req.body);
  res.json(await commerce.confirmFakePayment(req.auth!.userId, orderId, idempotencyKey(req.get("idempotency-key"))));
}));

export const paymentWebhookRouter = Router();
paymentWebhookRouter.post("/webhook/:provider", asyncRoute(async (req, res) => { const provider = z.string().trim().regex(/^[a-z0-9_-]{2,40}$/).parse(req.params.provider); const signature = req.get("x-payment-signature"); if (!signature) throw badRequest("WEBHOOK_SIGNATURE_REQUIRED", "A payment signature is required."); res.status(202).json(await commerce.handlePaymentWebhook(provider, req.body as Buffer, signature)); }));
