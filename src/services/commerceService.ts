import { createHash, randomBytes } from "node:crypto";
import { LearningResourceType, Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { ApiError, badRequest, conflict, notFound } from "../errors/api-error.js";
import { getPaymentProvider } from "../integrations/provider-registry.js";
import { getConfig } from "../config/env.js";
import { scheduleMonthlyReportForEntitlement } from "./monthlyReportService.js";
import { enqueuePurchaseInvoiceEmail } from "./purchaseInvoiceEmailService.js";
import { resolveEntitlementExpiry } from "./resourceValidityService.js";

const orderNumber = () => `PF-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(5).toString("hex").toUpperCase()}`;
const receiptNumber = () => `RCP-${Date.now()}-${randomBytes(3).toString("hex").toUpperCase()}`;
const requestHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function grantOrderEntitlements(tx: Prisma.TransactionClient, orderId: string) {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      items: {
        include: {
          contentItem: { select: { id: true, courseId: true, entityType: true, accessDurationValue: true, accessDurationUnit: true } },
          package: { select: { id: true, courseId: true, accessDurationValue: true, accessDurationUnit: true } },
          questionBank: { select: { id: true, courseId: true, accessDurationValue: true, accessDurationUnit: true } },
        },
      },
    },
  });
  const startsAt = order.paidAt ?? new Date();
  for (const item of order.items) {
    const duplicate = await tx.entitlement.findFirst({ where: { userId: order.userId, orderId, packageId: item.packageId, contentItemId: item.contentItemId, questionBankId: item.questionBankId } });
    const resourceType = item.contentItem?.entityType === "MONTHLY_REPORT" ? "MONTHLY_REPORT" : item.resourceType;
    // Entitlement_resource_xor requires exactly one concrete resource
    // reference. Course scope is derived through the linked content/package.
    const policy = item.contentItem ?? item.package ?? item.questionBank;
    const expiresAt = policy ? resolveEntitlementExpiry(policy, startsAt) : null;
    const entitlement = duplicate ?? await tx.entitlement.create({ data: {
      userId: order.userId,
      resourceType,
      contentItemId: item.contentItemId,
      packageId: item.packageId,
      questionBankId: item.questionBankId,
      resourceTitle: item.titleSnapshot,
      source: "PURCHASE",
      orderId,
      accessType: expiresAt ? "TIME_LIMITED" : "PERMANENT",
      status: "ACTIVE",
      purchasedAt: startsAt,
      startsAt,
      expiresAt,
    } });
    if (item.contentItem?.entityType === "MONTHLY_REPORT") await scheduleMonthlyReportForEntitlement(tx, { userId: order.userId, courseId: item.contentItem.courseId, contentItemId: item.contentItem.id, entitlementId: entitlement.id, orderId, grantedAt: startsAt });
  }
  await tx.order.update({ where: { id: orderId }, data: { accessStatus: "GRANTED" } });
}

type CheckoutInput = {
  packageIds?: string[];
  items?: Array<{ resourceType: "PACKAGE" | "CONTENT" | "QUESTION_BANK"; resourceId: string }>;
  couponCode?: string;
};

export async function createCheckout(userId: string, input: CheckoutInput, idempotencyKey: string) {
  const hash = requestHash(input);
  const existing = await prisma.idempotencyRecord.findUnique({ where: { scope_key: { scope: `checkout:${userId}`, key: idempotencyKey } } });
  if (existing) {
    if (existing.requestHash !== hash) throw conflict("IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used with a different request.");
    if (existing.responseCode >= 400) throw new ApiError(existing.responseCode, "CHECKOUT_PREVIOUSLY_FAILED", "The prior checkout attempt with this idempotency key failed.");
    return existing.responseBody;
  }
  const packageIds = [...new Set([...(input.packageIds ?? []), ...(input.items ?? []).filter((item) => item.resourceType === "PACKAGE").map((item) => item.resourceId)])];
  const contentIds = [...new Set((input.items ?? []).filter((item) => item.resourceType === "CONTENT").map((item) => item.resourceId))];
  const questionBankIds = [...new Set((input.items ?? []).filter((item) => item.resourceType === "QUESTION_BANK").map((item) => item.resourceId))];
  if (!packageIds.length && !contentIds.length && !questionBankIds.length) throw badRequest("INVALID_CHECKOUT_ITEMS", "At least one purchasable item is required.");
  if (packageIds.length + contentIds.length + questionBankIds.length > 50) throw badRequest("CHECKOUT_ITEM_LIMIT_EXCEEDED", "A checkout can contain at most 50 items.");

  const [packages, contentItems, questionBanks, preference] = await Promise.all([
    prisma.package.findMany({ where: { id: { in: packageIds }, status: "PUBLISHED", deletedAt: null, course: { status: "ACTIVE", deletedAt: null } }, take: 50, include: { course: true } }),
    prisma.contentItem.findMany({ where: { id: { in: contentIds }, OR: [{ kind: "FILE" }, { entityType: "MONTHLY_REPORT" }], accessType: "PAID", status: "PUBLISHED", deletedAt: null, price: { not: null }, course: { status: "ACTIVE", deletedAt: null } }, take: 50, include: { course: true } }),
    prisma.questionBank.findMany({ where: { id: { in: questionBankIds }, accessType: "PAID", price: { gt: 0 }, status: "PUBLISHED", deletedAt: null, course: { status: "ACTIVE", deletedAt: null } }, take: 50, include: { course: true } }),
    prisma.learnerPreference.findUnique({ where: { userId }, select: { selectedCourseId: true } }),
  ]);
  if (packages.length !== packageIds.length || contentItems.length !== contentIds.length || questionBanks.length !== questionBankIds.length) throw badRequest("INVALID_CHECKOUT_ITEMS", "Every checkout item must be published, paid, and available.");
  const courseIds = [...packages.map((item) => item.courseId), ...contentItems.map((item) => item.courseId), ...questionBanks.map((item) => item.courseId)];
  if (new Set(courseIds).size !== 1) throw badRequest("MULTI_COURSE_CHECKOUT_UNSUPPORTED", "A checkout can contain items from only one course.");
  if (!preference?.selectedCourseId || preference.selectedCourseId !== courseIds[0]) throw badRequest("COURSE_NOT_ELIGIBLE", "This product is not available for the learner's selected course.");
  const alreadyOwned = await prisma.entitlement.findFirst({
    where: {
      userId,
      status: "ACTIVE",
      OR: [
        { packageId: { in: packageIds } },
        { contentItemId: { in: contentIds } },
        { questionBankId: { in: questionBankIds } },
        ...(contentIds.length ? [{ package: { is: { items: { some: { contentItemId: { in: contentIds } } } } } }] : []),
      ],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
    },
    select: { resourceTitle: true },
  });
  if (alreadyOwned) throw conflict("CHECKOUT_ITEM_ALREADY_OWNED", `${alreadyOwned.resourceTitle} is already available in your library.`);
  const subtotal = [...packages.map((item) => Number(item.price)), ...contentItems.map((item) => Number(item.price)), ...questionBanks.map((item) => Number(item.price))].reduce((sum, price) => sum + price, 0);
  let coupon: Awaited<ReturnType<typeof prisma.coupon.findFirst>> = null; let discount = 0;
  if (input.couponCode) {
    coupon = await prisma.coupon.findFirst({ where: { code: input.couponCode.toUpperCase(), enabled: true } });
    if (!coupon || (coupon.expiresAt && coupon.expiresAt <= new Date()) || (coupon.maxUses !== null && coupon.usageCount >= coupon.maxUses)) throw badRequest("COUPON_UNAVAILABLE", "The coupon is invalid, expired, or exhausted.");
    const targets = await prisma.couponTarget.findMany({ where: { couponId: coupon.id }, take: 1_001 });
    if (targets.length > 1_000) throw badRequest("COUPON_TARGET_LIMIT_EXCEEDED", "This coupon has too many targets to evaluate safely.");
    if (coupon.scope === "PACKAGES" && !packages.some((item) => targets.some((target) => target.packageId === item.id))) throw badRequest("COUPON_NOT_APPLICABLE", "The coupon does not apply to these packages.");
    discount = coupon.discountType === "PERCENT" ? Math.min(subtotal, subtotal * Number(coupon.discountValue) / 100) : Math.min(subtotal, Number(coupon.discountValue));
  }
  const total = Math.max(0, Number((subtotal - discount).toFixed(2)));
  const fakePaymentEnabled = getConfig().payment.fakePaymentEnabled;
  const provider = total > 0 && !fakePaymentEnabled ? getPaymentProvider() : null;
  let order;
  try {
    order = await prisma.$transaction(async (tx) => {
    if (coupon) {
      const claimed = await tx.coupon.updateMany({ where: { id: coupon.id, enabled: true, usageCount: coupon.maxUses === null ? undefined : { lt: coupon.maxUses } }, data: { usageCount: { increment: 1 } } });
      if (!claimed.count) throw conflict("COUPON_EXHAUSTED", "The coupon was exhausted by another checkout.");
    }
    const created = await tx.order.create({ data: { orderNumber: orderNumber(), userId, courseId: courseIds[0], subtotal, discountAmount: discount, totalAmount: total, status: total === 0 ? "PAID" : "CREATED", accessStatus: "PENDING", isComplimentary: total === 0, paidAt: total === 0 ? new Date() : null, receiptNumber: total === 0 ? receiptNumber() : null, paymentMethod: total === 0 ? "COMPLIMENTARY" : null, items: { create: [
      ...packages.map((item) => ({ packageId: item.id, resourceType: "PACKAGE" as const, titleSnapshot: item.title, unitPrice: item.price, quantity: 1, totalPrice: item.price })),
      ...contentItems.map((item) => ({ contentItemId: item.id, resourceType: item.entityType === "MONTHLY_REPORT" ? LearningResourceType.MONTHLY_REPORT : LearningResourceType.PREMIUM_NOTES, titleSnapshot: item.name, unitPrice: item.price!, quantity: 1, totalPrice: item.price! })),
      ...questionBanks.map((item) => ({ questionBankId: item.id, resourceType: LearningResourceType.QUESTION_BANK, titleSnapshot: item.name, unitPrice: item.price, quantity: 1, totalPrice: item.price })),
    ] } } });
    if (coupon) await tx.couponRedemption.create({ data: { couponId: coupon.id, userId, orderId: created.id, discountAmount: discount } });
    if (total === 0) await grantOrderEntitlements(tx, created.id);
    else await tx.payment.create({ data: { orderId: created.id, provider: fakePaymentEnabled ? "test" : "configured", amount: total, currency: "INR", status: "PENDING", paymentMethod: fakePaymentEnabled ? "FAKE_TEST_PAYMENT" : null } });
    await tx.idempotencyRecord.create({ data: { scope: `checkout:${userId}`, key: idempotencyKey, requestHash: hash, responseCode: 201, responseBody: { orderId: created.id, orderNumber: created.orderNumber, status: created.status, currency: created.currency, subtotal, discountAmount: discount, totalAmount: total, paymentMode: fakePaymentEnabled && total > 0 ? "FAKE_TEST" : total === 0 ? "COMPLIMENTARY" : "PROVIDER", requiresFakePayment: fakePaymentEnabled && total > 0 }, expiresAt: new Date(Date.now() + 24 * 60 * 60_000) } });
    return created;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await prisma.idempotencyRecord.findUnique({ where: { scope_key: { scope: `checkout:${userId}`, key: idempotencyKey } } });
      if (winner?.requestHash !== hash) throw conflict("IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used with a different request.");
      if (winner) return winner.responseBody;
    }
    throw error;
  }
  let response: Record<string, unknown> = { orderId: order.id, orderNumber: order.orderNumber, status: order.status, currency: order.currency, subtotal, discountAmount: discount, totalAmount: total, paymentMode: fakePaymentEnabled && total > 0 ? "FAKE_TEST" : total === 0 ? "COMPLIMENTARY" : "PROVIDER", requiresFakePayment: fakePaymentEnabled && total > 0 };
  if (provider) {
    try {
      const checkout = await provider.createCheckout({ orderId: order.id, amountMinor: Math.round(total * 100), currency: order.currency, idempotencyKey });
      await prisma.payment.updateMany({ where: { orderId: order.id, status: "PENDING" }, data: { providerPaymentId: checkout.providerPaymentId } });
      response = { ...response, checkoutUrl: checkout.redirectUrl };
    } catch (error) {
      await prisma.$transaction(async (tx) => {
        await tx.payment.updateMany({ where: { orderId: order.id, status: "PENDING" }, data: { status: "FAILED", failureReason: error instanceof Error ? error.message.slice(0, 500) : "Provider failure" } });
        await tx.order.update({ where: { id: order.id }, data: { status: "FAILED" } });
        if (coupon) { await tx.couponRedemption.deleteMany({ where: { orderId: order.id, couponId: coupon.id } }); await tx.coupon.update({ where: { id: coupon.id }, data: { usageCount: { decrement: 1 } } }); }
        await tx.idempotencyRecord.update({ where: { scope_key: { scope: `checkout:${userId}`, key: idempotencyKey } }, data: { responseCode: 502, responseBody: { orderId: order.id, status: "FAILED", code: "PAYMENT_PROVIDER_FAILED" } } });
      });
      throw new ApiError(502, "PAYMENT_PROVIDER_FAILED", "The payment provider could not create checkout.");
    }
  }
  await prisma.idempotencyRecord.update({ where: { scope_key: { scope: `checkout:${userId}`, key: idempotencyKey } }, data: { responseBody: response as Prisma.InputJsonValue } });
  return response;
}

export async function confirmFakePayment(userId: string, orderId: string, idempotencyKey: string) {
  if (!getConfig().payment.fakePaymentEnabled) throw notFound("FAKE_PAYMENT_NOT_AVAILABLE", "Test payment is not available in this environment.");
  const scope = `fake-payment:${userId}:${orderId}`;
  const hash = requestHash({ orderId, outcome: "SUCCESS" });
  const existing = await prisma.idempotencyRecord.findUnique({ where: { scope_key: { scope, key: idempotencyKey } } });
  if (existing) {
    if (existing.requestHash !== hash) throw conflict("IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used with a different request.");
    return existing.responseBody;
  }

  const order = await prisma.order.findFirst({ where: { id: orderId, userId }, include: { payments: true } });
  if (!order) throw notFound("ORDER_NOT_FOUND", "The order was not found.");
  if (order.status === "PAID" && order.accessStatus === "GRANTED") {
    return { orderId: order.id, orderNumber: order.orderNumber, status: order.status, accessStatus: order.accessStatus, receiptNumber: order.receiptNumber, paidAt: order.paidAt, duplicate: true };
  }
  if (order.status !== "CREATED") throw conflict("ORDER_NOT_PAYABLE", "Only a newly created order can complete test payment.");
  const payment = order.payments.find((item) => item.status === "PENDING" && item.provider === "test");
  if (!payment) throw conflict("TEST_PAYMENT_NOT_PENDING", "This order has no pending test payment.");

  const response = await prisma.$transaction(async (tx) => {
    const claimed = await tx.order.updateMany({ where: { id: orderId, userId, status: "CREATED" }, data: { status: "PAID", paidAt: new Date(), receiptNumber: order.receiptNumber ?? receiptNumber(), paymentMethod: "FAKE_TEST_PAYMENT" } });
    if (!claimed.count) {
      const winner = await tx.order.findFirst({ where: { id: orderId, userId } });
      if (winner?.status === "PAID") return { orderId: winner.id, orderNumber: winner.orderNumber, status: winner.status, accessStatus: winner.accessStatus, receiptNumber: winner.receiptNumber, paidAt: winner.paidAt, duplicate: true };
      throw conflict("ORDER_NOT_PAYABLE", "The order is no longer payable.");
    }
    await tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCESS", providerPaymentId: `TEST-${orderId}`, paymentMethod: "FAKE_TEST_PAYMENT", failureReason: null } });
    await grantOrderEntitlements(tx, orderId);
    await enqueuePurchaseInvoiceEmail(tx, orderId);
    const paid = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    const result = { orderId: paid.id, orderNumber: paid.orderNumber, status: paid.status, accessStatus: paid.accessStatus, receiptNumber: paid.receiptNumber, paidAt: paid.paidAt, duplicate: false };
    await tx.idempotencyRecord.create({ data: { scope, key: idempotencyKey, requestHash: hash, responseCode: 200, responseBody: result, expiresAt: new Date(Date.now() + 24 * 60 * 60_000) } });
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return response;
}

export async function handlePaymentWebhook(providerName: string, rawBody: Buffer, signature: string) {
  if (providerName !== getConfig().payment.providerName) throw notFound("PAYMENT_PROVIDER_NOT_FOUND", "The payment provider webhook route was not found.");
  const provider = getPaymentProvider();
  let verified;
  try { verified = await provider.verifyWebhook(rawBody, signature); }
  catch { throw badRequest("INVALID_WEBHOOK_SIGNATURE", "The payment webhook signature or envelope is invalid."); }
  const hash = createHash("sha256").update(rawBody).digest("hex");
  let event = await prisma.paymentWebhookEvent.findUnique({ where: { provider_providerEventId: { provider: providerName, providerEventId: verified.eventId } } });
  if (!event) {
    try {
      event = await prisma.paymentWebhookEvent.create({ data: { provider: providerName, providerEventId: verified.eventId, eventType: verified.eventType, payloadHash: hash } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      event = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: providerName, providerEventId: verified.eventId } } });
    }
  }
  if (event.payloadHash !== hash) throw conflict("WEBHOOK_EVENT_CONFLICT", "The provider event ID was reused with different content.");
  if (event.status === "PROCESSED") return { accepted: true, duplicate: true };
  const claimed = await prisma.paymentWebhookEvent.updateMany({
    where: { id: event.id, status: { in: ["RECEIVED", "FAILED"] } },
    data: { status: "PROCESSING", lastError: null },
  });
  if (!claimed.count) return { accepted: true, duplicate: true };
  const payload = verified.payload as { providerPaymentId?: string; status?: string };
  if (!payload.providerPaymentId) throw badRequest("INVALID_WEBHOOK_PAYLOAD", "The verified webhook contains no provider payment ID.");
  try {
    await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findFirst({ where: { providerPaymentId: payload.providerPaymentId }, include: { order: true } });
      if (!payment) throw notFound("PAYMENT_NOT_FOUND", "The payment referenced by the webhook was not found.");
      if (verified.eventType === "PAYMENT_SUCCEEDED" || payload.status === "SUCCESS") {
        if (payment.order.status === "CANCELLED" || payment.order.status === "REFUNDED") {
          throw conflict("ORDER_NOT_PAYABLE", "A cancelled or refunded order cannot be marked paid by a late webhook.");
        }
        if (payment.status !== "SUCCESS") {
          await tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCESS" } });
          await tx.order.update({ where: { id: payment.orderId }, data: { status: "PAID", paidAt: new Date(), receiptNumber: payment.order.receiptNumber ?? receiptNumber() } });
          await grantOrderEntitlements(tx, payment.orderId);
          await enqueuePurchaseInvoiceEmail(tx, payment.orderId);
        }
      } else if (verified.eventType === "PAYMENT_FAILED" || payload.status === "FAILED") {
        if (payment.order.status !== "CANCELLED" && payment.order.status !== "REFUNDED" && payment.status !== "SUCCESS") {
          await tx.payment.update({ where: { id: payment.id }, data: { status: "FAILED", failureReason: "Provider reported failure" } });
          await tx.order.update({ where: { id: payment.orderId }, data: { status: "FAILED" } });
        }
      }
      await tx.paymentWebhookEvent.update({ where: { id: event.id }, data: { status: "PROCESSED", processedAt: new Date(), lastError: null } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { accepted: true, duplicate: false };
  } catch (error) {
    await prisma.paymentWebhookEvent.update({ where: { id: event.id }, data: { status: "FAILED", lastError: error instanceof Error ? error.message.slice(0, 1_000) : "Unknown webhook error" } });
    throw error;
  }
}
