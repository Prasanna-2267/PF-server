import { Prisma } from "../../generated/prisma/client.js";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { getEmailProvider } from "../integrations/provider-registry.js";

export const PURCHASE_INVOICE_EMAIL_JOB = "PURCHASE_INVOICE_EMAIL";
const payloadSchema = z.object({ orderId: z.string().uuid() }).strict();

export function enqueuePurchaseInvoiceEmail(tx: Prisma.TransactionClient, orderId: string) {
  return tx.backgroundJob.upsert({
    where: { kind_deduplicationKey: { kind: PURCHASE_INVOICE_EMAIL_JOB, deduplicationKey: orderId } },
    create: { kind: PURCHASE_INVOICE_EMAIL_JOB, deduplicationKey: orderId, payload: { orderId }, runAt: new Date(), maxAttempts: 5 },
    update: {},
  });
}

export async function deliverPurchaseInvoiceEmail(value: unknown) {
  const { orderId } = payloadSchema.parse(value);
  const order = await prisma.order.findFirst({
    where: { id: orderId, status: "PAID", totalAmount: { gt: 0 } },
    include: { user: { select: { email: true, fullName: true } }, course: { select: { name: true } }, items: { orderBy: { id: "asc" } } },
  });
  if (!order) return { skipped: true };
  return getEmailProvider().send({
    to: order.user.email,
    template: "purchase-invoice",
    variables: {
      userName: order.user.fullName,
      orderNumber: order.orderNumber,
      receiptNumber: order.receiptNumber ?? order.orderNumber,
      paidAt: (order.paidAt ?? order.updatedAt).toISOString(),
      courseName: order.course?.name ?? "Parallax Flow",
      currency: order.currency,
      subtotal: Number(order.subtotal).toFixed(2),
      discount: Number(order.discountAmount).toFixed(2),
      total: Number(order.totalAmount).toFixed(2),
      paymentMethod: order.paymentMethod ?? "Online payment",
      items: order.items.map((item) => `${item.titleSnapshot} × ${item.quantity} — ${order.currency} ${Number(item.totalPrice).toFixed(2)}`).join("\n"),
    },
    idempotencyKey: `purchase-invoice:${order.id}`,
  });
}
