import { randomUUID } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { dispatchQueuedNotification, runScheduledNotificationsOnce } from "./academyNotificationService.js";
import { publishScheduledBroadcast } from "./academyAdminService.js";
import { publishBroadcast as publishGlobalBroadcast } from "./adminBroadcastService.js";
import { getConfig } from "../config/env.js";
import { getEmailProvider } from "../integrations/provider-registry.js";
import { executeContentTreeCopyJob } from "./contentService.js";
import { dispatchLearnerPushDeliveries, runLearnerReminderSweep } from "./learnerNotificationService.js";
import { ACCOUNT_CREATED_EMAIL_JOB, deliverAccountCreatedEmail } from "./accountCreatedEmailService.js";
import { PURCHASE_INVOICE_EMAIL_JOB, deliverPurchaseInvoiceEmail } from "./purchaseInvoiceEmailService.js";
import { MONTHLY_REPORT_EMAIL_JOB, deliverMonthlyReportEmail } from "./monthlyReportEmailService.js";
import { USER_LIFECYCLE_EMAIL_JOB, deliverUserLifecycleEmail } from "./userLifecycleEmailService.js";

export interface EnqueueJobInput { kind: string; payload: Prisma.InputJsonValue; academyId?: string; createdById?: string; runAt?: Date; deduplicationKey?: string; maxAttempts?: number }
export async function enqueueJob(input: EnqueueJobInput, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  if (input.deduplicationKey) return tx.backgroundJob.upsert({ where: { kind_deduplicationKey: { kind: input.kind, deduplicationKey: input.deduplicationKey } }, create: { kind: input.kind, payload: input.payload, academyId: input.academyId, createdById: input.createdById, runAt: input.runAt, deduplicationKey: input.deduplicationKey, maxAttempts: input.maxAttempts ?? 5 }, update: { payload: input.payload, runAt: input.runAt, status: "PENDING", lockedAt: null, lockedBy: null, lastError: null, completedAt: null } });
  return tx.backgroundJob.create({ data: { kind: input.kind, payload: input.payload, academyId: input.academyId, createdById: input.createdById, runAt: input.runAt, maxAttempts: input.maxAttempts ?? 5 } });
}

async function execute(job: { id: string; kind: string; payload: unknown; academyId: string | null; createdById: string | null }) {
  const { kind } = job; const data = job.payload as Record<string, unknown>;
  if (kind === "NOTIFICATION_DISPATCH") return runScheduledNotificationsOnce();
  if (kind === "NOTIFICATION_SEND") return dispatchQueuedNotification(String(data.notificationId), String(data.academyId), data.actorId ? String(data.actorId) : undefined);
  if (kind === "BROADCAST_PUBLISH") return publishScheduledBroadcast(String(data.broadcastId), String(data.academyId), String(data.actorId));
  if (kind === "GLOBAL_BROADCAST_PUBLISH") return publishGlobalBroadcast(String(data.actorId), String(data.broadcastId));
  if (kind === "LEARNER_PUSH_DELIVERY") return dispatchLearnerPushDeliveries(data.sourceKey ? String(data.sourceKey) : undefined);
  if (kind === "LEARNER_REMINDER_SWEEP") return runLearnerReminderSweep();
  if (kind === ACCOUNT_CREATED_EMAIL_JOB) return deliverAccountCreatedEmail(data);
  if (kind === PURCHASE_INVOICE_EMAIL_JOB) return deliverPurchaseInvoiceEmail(data);
  if (kind === MONTHLY_REPORT_EMAIL_JOB) return deliverMonthlyReportEmail(data);
  if (kind === USER_LIFECYCLE_EMAIL_JOB) return deliverUserLifecycleEmail(data);
  if (kind === "MONTHLY_REPORT_GENERATE") {
    // Loaded lazily to keep the queue service independent from producers that
    // enqueue jobs inside a commerce transaction.
    const { generateMonthlyReport } = await import("./monthlyReportService.js");
    return generateMonthlyReport(String(data.reportId));
  }
  if (kind === "CONTACT_EMAIL") {
    const submission = await prisma.contactSubmission.findUniqueOrThrow({ where: { id: String(data.submissionId) }, include: { academy: { select: { email: true } } } });
    const recipient = submission.academy?.email ?? getConfig().email.contactRecipient;
    if (!recipient) throw new Error("CONTACT_RECIPIENT_NOT_CONFIGURED");
    const sent = await getEmailProvider().send({ to: recipient, template: "contact-submission", variables: { name: submission.name, email: submission.email, phone: submission.phone ?? "", subject: submission.subject, message: submission.message }, idempotencyKey: `contact:${submission.id}` });
    await prisma.contactSubmission.update({ where: { id: submission.id }, data: { status: "DELIVERED" } });
    return sent;
  }
  if (kind === "CONTENT_TREE_COPY") {
    if (!job.createdById) throw new Error("CONTENT_TREE_COPY_ACTOR_MISSING");
    return executeContentTreeCopyJob({ jobId: job.id, actorId: job.createdById, academyId: job.academyId ?? undefined, contentId: String(data.contentId), destinationParentId: data.destinationParentId == null ? null : String(data.destinationParentId) });
  }
  throw new Error(`Unsupported background job kind: ${kind}`);
}

export async function runDueJobsOnce(options: { workerId?: string; limit?: number } = {}) {
  const workerId = options.workerId ?? `worker-${randomUUID()}`;
  const staleBefore = new Date(Date.now() - 10 * 60_000);
  const stale = await prisma.backgroundJob.findMany({
    where: { status: "PROCESSING", lockedAt: { lt: staleBefore } },
    orderBy: [{ lockedAt: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true, lockedAt: true, attemptCount: true, maxAttempts: true },
  });
  for (const job of stale) {
    const terminal = job.attemptCount >= job.maxAttempts;
    await prisma.backgroundJob.updateMany({
      where: { id: job.id, status: "PROCESSING", lockedAt: job.lockedAt },
      data: {
        status: terminal ? "FAILED" : "PENDING",
        lockedAt: null,
        lockedBy: null,
        lastError: terminal ? "STALE_LEASE_ATTEMPTS_EXHAUSTED" : "STALE_LEASE_RECOVERED",
      },
    });
  }
  const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
  const candidates = await prisma.backgroundJob.findMany({
    where: { status: "PENDING", runAt: { lte: new Date() } },
    orderBy: [{ runAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true, attemptCount: true, maxAttempts: true },
  });
  const results: Array<{ id: string; status: string }> = [];
  for (const candidate of candidates) {
    if (candidate.attemptCount >= candidate.maxAttempts) {
      await prisma.backgroundJob.updateMany({ where: { id: candidate.id, status: "PENDING" }, data: { status: "FAILED", lastError: "MAX_ATTEMPTS_EXHAUSTED" } });
      results.push({ id: candidate.id, status: "FAILED" });
      continue;
    }
    const claimed = await prisma.backgroundJob.updateMany({ where: { id: candidate.id, status: "PENDING", lockedAt: null }, data: { status: "PROCESSING", lockedAt: new Date(), lockedBy: workerId, attemptCount: { increment: 1 } } });
    if (!claimed.count) continue;
    const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: candidate.id } });
    try {
      const result = await execute(job);
      const completed = await prisma.backgroundJob.updateMany({ where: { id: job.id, status: "PROCESSING", lockedBy: workerId }, data: { status: "COMPLETED", completedAt: new Date(), lockedAt: null, lockedBy: null, lastError: null, payload: { ...(job.payload as Record<string, unknown>), result } as Prisma.InputJsonValue } });
      results.push({ id: job.id, status: completed.count ? "COMPLETED" : "CANCELLED_OR_LEASE_LOST" });
    } catch (error) {
      const terminal = job.attemptCount >= job.maxAttempts;
      const delaySeconds = Math.min(3_600, 2 ** Math.min(job.attemptCount, 10) * 15);
      const failed = await prisma.backgroundJob.updateMany({ where: { id: job.id, status: "PROCESSING", lockedBy: workerId }, data: { status: terminal ? "FAILED" : "PENDING", runAt: terminal ? job.runAt : new Date(Date.now() + delaySeconds * 1_000), lockedAt: null, lockedBy: null, lastError: error instanceof Error ? error.message.slice(0, 2_000) : "Unknown job error" } });
      results.push({ id: job.id, status: failed.count ? (terminal ? "FAILED" : "RETRY_SCHEDULED") : "CANCELLED_OR_LEASE_LOST" });
    }
  }
  return results;
}
