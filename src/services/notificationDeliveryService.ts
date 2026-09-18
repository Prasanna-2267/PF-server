import { prisma } from "../db/prisma.js";
import { getEmailProvider } from "../integrations/provider-registry.js";

export type DeliveryChannel = "IN_APP" | "EMAIL";

export function assertChannelsConfigured(channels: DeliveryChannel[]) {
  if (channels.includes("EMAIL")) getEmailProvider();
}

export async function recordInAppDeliveries(notificationId: string, academyId: string, studentUserIds: string[]) {
  if (!studentUserIds.length) return;
  await prisma.notificationDelivery.createMany({ data: studentUserIds.map((recipientUserId) => ({ notificationId, academyId, recipientUserId, channel: "IN_APP", status: "DELIVERED", idempotencyKey: `notification:${notificationId}:in_app:${recipientUserId}`, attemptCount: 1, deliveredAt: new Date() })), skipDuplicates: true });
}

export async function deliverEmails(notificationId: string, academyId: string, studentUserIds: string[]) {
  const provider = getEmailProvider();
  const notification = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId }, select: { title: true, body: true } });
  const users = await prisma.user.findMany({ where: { id: { in: studentUserIds }, deletedAt: null }, take: 50_000, select: { id: true, email: true, fullName: true } });
  const results: Array<{ userId: string; delivered: boolean }> = [];
  for (const user of users) {
    const idempotencyKey = `notification:${notificationId}:email:${user.id}`;
    const delivery = await prisma.notificationDelivery.upsert({ where: { idempotencyKey }, create: { notificationId, academyId, recipientUserId: user.id, channel: "EMAIL", idempotencyKey, status: "PROCESSING", attemptCount: 1 }, update: { status: "PROCESSING", attemptCount: { increment: 1 }, lastError: null } });
    if (delivery.status === "DELIVERED") { results.push({ userId: user.id, delivered: true }); continue; }
    try {
      const sent = await provider.send({ to: user.email, recipientSource: "registered-user", template: "academy-notification", variables: { name: user.fullName, title: notification.title, body: notification.body }, idempotencyKey });
      await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { status: "DELIVERED", deliveredAt: new Date(), providerMessageId: sent.providerMessageId } });
      results.push({ userId: user.id, delivered: true });
    } catch (error) {
      await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { status: "FAILED", lastError: error instanceof Error ? error.message.slice(0, 1_000) : "Unknown provider error", nextAttemptAt: new Date(Date.now() + 60_000) } });
      results.push({ userId: user.id, delivered: false });
    }
  }
  return results;
}
