import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { prisma } from "../db/prisma.js";
import { databaseDate, databaseDateKey } from "../services/learnerTime.js";
import { confirmFakePayment, createCheckout } from "../services/commerceService.js";
import { providerTestHooks } from "../integrations/provider-registry.js";
import * as reports from "../services/monthlyReportService.js";
import * as reportViewer from "../services/monthlyReportViewerService.js";
import { deliverMonthlyReportEmail } from "../services/monthlyReportEmailService.js";
import type { EmailMessage } from "../integrations/email-provider.js";
import { integrationDatabaseEnabled } from "../tests/integration-database-guard.js";

const enabled = integrationDatabaseEnabled("RUN_BACKEND_INTEGRATION");
const suffix = randomUUID().slice(0, 8);
let userId = "";
let otherUserId = "";
let courseId = "";
let noteId = "";
let productId = "";
let orderId = "";
let previousMonth = "";
let purchaseMonth = "";
const storedObjects = new Map<string, Buffer>();
const sentEmails: EmailMessage[] = [];

before(async () => {
  if (!enabled) return;
  const role = await prisma.role.upsert({ where: { key: "student" }, create: { key: "student", name: "Student", description: "Learner role" }, update: {}, select: { id: true } });
  userId = randomUUID(); otherUserId = randomUUID(); courseId = randomUUID(); noteId = randomUUID();
  const previous = new Date(); previous.setUTCMonth(previous.getUTCMonth() - 1, 10); previousMonth = databaseDateKey(previous).slice(0, 7);
  purchaseMonth = databaseDateKey(new Date()).slice(0, 7);
  await prisma.user.create({ data: { id: userId, email: `monthly-${suffix}@test.local`, fullName: "Paid Learner", roleId: role.id } });
  await prisma.user.create({ data: { id: otherUserId, email: `monthly-other-${suffix}@test.local`, fullName: "Other Learner", roleId: role.id } });
  await prisma.course.create({ data: { id: courseId, slug: `monthly-${suffix}`, code: `M${suffix.slice(0, 6)}`, name: "Monthly Course" } });
  await prisma.contentItem.create({ data: { id: noteId, courseId, kind: "FILE", name: "Monthly Note", mimeType: "application/pdf", storagePath: `integration/monthly-${suffix}.pdf` } });
  await prisma.learnerPreference.create({ data: { userId, selectedCourseId: courseId, timezone: "UTC", dailyTargetMinutes: 30 } });
  productId = (await reports.ensureMonthlyReportProduct(courseId)).id;
  await prisma.learnerDailyActivity.create({ data: { userId, localDate: databaseDate(`${previousMonth}-10`), timezone: "UTC", targetMinutes: 30, focusSeconds: 1800, readingSeconds: 600, focusSessionCount: 1, qualifiesStreak: true, goalCompleted: true, lastActivityAt: previous } });
  await prisma.learnerStreakDay.create({ data: { userId, localDate: databaseDate(`${previousMonth}-10`), timezone: "UTC", focusSeconds: 1800, targetMinutes: 30, qualifiedAt: previous } });
  await prisma.learnerNoteState.create({ data: { userId, contentItemId: noteId, completed: true, completedAt: previous, revisionCount: 1 } });
  await prisma.noteRevisionEvent.create({ data: { userId, contentItemId: noteId, source: "MANUAL", revisedAt: previous } });
  providerTestHooks.setStorage({
    async createUploadUrl() { throw new Error("not used"); },
    async createDownloadUrl(objectKey) { const body = storedObjects.get(objectKey); if (!body) throw new Error("missing test object"); return `data:application/pdf;base64,${body.toString("base64")}`; },
    async statObject(objectKey) { const body = storedObjects.get(objectKey); if (!body) throw new Error("missing test object"); return { sizeBytes: body.length, mimeType: "application/pdf" }; },
    async deleteObject(objectKey) { storedObjects.delete(objectKey); },
    async copyObject(sourceObjectKey, destinationObjectKey) { storedObjects.set(destinationObjectKey, Buffer.from(storedObjects.get(sourceObjectKey)!)); },
    async putObject(objectKey, body) { storedObjects.set(objectKey, Buffer.from(body)); },
  });
  providerTestHooks.setEmail({ async send(message) { sentEmails.push(message); return { providerMessageId: `email-${sentEmails.length}` }; } });
});

after(async () => {
  if (!enabled) return;
  const reportIds = (await prisma.learnerMonthlyReport.findMany({ where: { userId }, select: { id: true, version: true } }));
  if (reportIds.length) await prisma.backgroundJob.deleteMany({ where: { kind: { in: ["MONTHLY_REPORT_GENERATE", "MONTHLY_REPORT_EMAIL"] }, OR: reportIds.map((report) => ({ deduplicationKey: { contains: report.id } })) } });
  await prisma.learnerMonthlyReport.deleteMany({ where: { userId } });
  await prisma.entitlement.deleteMany({ where: { userId } });
  if (orderId) await prisma.order.deleteMany({ where: { id: orderId } });
  await prisma.idempotencyRecord.deleteMany({ where: { scope: { contains: userId } } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.contentItem.deleteMany({ where: { id: { in: [noteId, productId] } } });
  await prisma.course.delete({ where: { id: courseId } });
  await prisma.user.delete({ where: { id: otherUserId } });
  providerTestHooks.reset();
  storedObjects.clear();
  await prisma.$disconnect();
});

test("Monthly Report purchase grants its exact entitlement and schedules the purchase month", { skip: !enabled }, async () => {
  const locked = await reports.listMonthlyReports(userId);
  assert.equal(locked.access.owned, false);
  assert.equal(locked.items.length, 0);

  const checkout = await createCheckout(userId, { items: [{ resourceType: "CONTENT", resourceId: productId }] }, `monthly-checkout-${suffix}`) as { orderId: string; requiresFakePayment?: boolean };
  orderId = checkout.orderId;
  assert.equal(checkout.requiresFakePayment, true);
  const payment = await confirmFakePayment(userId, orderId, `monthly-payment-${suffix}`) as { status: string; accessStatus: string };
  assert.equal(payment.status, "PAID");
  assert.equal(payment.accessStatus, "GRANTED");
  const entitlement = await prisma.entitlement.findFirst({ where: { userId, contentItemId: productId, resourceType: "MONTHLY_REPORT", status: "ACTIVE" } });
  assert.ok(entitlement);

  const jobsBeforeArchiveRead = await prisma.backgroundJob.count({ where: { kind: "MONTHLY_REPORT_GENERATE" } });
  const first = await reports.listMonthlyReports(userId);
  const jobsAfterArchiveRead = await prisma.backgroundJob.count({ where: { kind: "MONTHLY_REPORT_GENERATE" } });
  assert.equal(jobsAfterArchiveRead, jobsBeforeArchiveRead, "opening the archive must not generate or enqueue reports");
  assert.equal(first.access.owned, true);
  const purchased = first.items.find((item) => item.yearMonth === purchaseMonth);
  assert.ok(purchased);
  assert.equal(purchased.status, "PENDING");
  assert.equal(purchased.canView, false);
  const replay = await reports.getMonthlyReport(userId, purchaseMonth);
  assert.equal(replay.id, purchased.id);
  assert.equal(replay.status, "PENDING");
  const scheduledJob = await prisma.backgroundJob.findUniqueOrThrow({ where: { kind_deduplicationKey: { kind: "MONTHLY_REPORT_GENERATE", deduplicationKey: `monthly-report:${purchased.id}:v${purchased.version}` } } });
  assert.ok(scheduledJob.runAt > new Date());

  const generated = await reports.generateMonthlyReport(purchased.id);
  assert.equal(generated.status, "READY");
  const persisted = await prisma.learnerMonthlyReport.findUniqueOrThrow({ where: { id: purchased.id } });
  assert.equal(persisted.status, "READY");
  assert.ok(persisted.storageKey);
  assert.equal((persisted.snapshotJson as { period?: { yearMonth?: string; endExclusive?: string } } | null)?.period?.yearMonth, purchaseMonth);
  assert.match((persisted.snapshotJson as { period?: { endExclusive?: string } } | null)?.period?.endExclusive ?? "", /^\d{4}-\d{2}-01$/);
  assert.ok(storedObjects.get(persisted.storageKey!)?.subarray(0, 5).equals(Buffer.from("%PDF-")));
  const emailJob = await prisma.backgroundJob.findUniqueOrThrow({ where: { kind_deduplicationKey: { kind: "MONTHLY_REPORT_EMAIL", deduplicationKey: `monthly-report-email:${purchased.id}:v${persisted.version}` } } });
  await deliverMonthlyReportEmail(emailJob.payload);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, `monthly-${suffix}@test.local`);
  assert.equal(sentEmails[0].attachments?.[0]?.contentType, "application/pdf");
  assert.ok(Buffer.from(sentEmails[0].attachments?.[0]?.contentBase64 ?? "", "base64").subarray(0, 5).equals(Buffer.from("%PDF-")));

  const session = await prisma.userSession.create({ data: { userId, authSessionId: `monthly-session-${suffix}`, expiresAt: new Date(Date.now() + 60_000) } });
  const otherSession = await prisma.userSession.create({ data: { userId: otherUserId, authSessionId: `monthly-other-session-${suffix}`, expiresAt: new Date(Date.now() + 60_000) } });
  const viewer = await reportViewer.createMonthlyReportViewerSession(userId, session.id, purchased.id);
  const ticket = new URL(viewer.contentUrl, "http://localhost").searchParams.get("ticket");
  assert.ok(ticket);
  const content = await reportViewer.getMonthlyReportViewerContentByTicket(viewer.viewerSessionId, ticket!);
  assert.equal(content.mimeType, "application/pdf");
  assert.ok(content.buffer.subarray(0, 5).equals(Buffer.from("%PDF-")));
  await assert.rejects(() => reportViewer.createMonthlyReportViewerSession(otherUserId, otherSession.id, purchased.id), /monthly report was not found/i);
});
