import { prisma } from '../db/prisma.js';
import type { TenantContext } from '../auth/tenant-auth.js';
import { Prisma } from '../../generated/prisma/client.js';
import { assertChannelsConfigured, deliverEmails, recordInAppDeliveries, type DeliveryChannel } from './notificationDeliveryService.js';
import { enqueueJob } from './backgroundJobService.js';
import { fanoutAcademyNotificationToMobile } from './learnerNotificationService.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const RECIPIENT_BATCH_SIZE = 1000;
const TITLE_MAX_LENGTH = 180;
const BODY_MAX_LENGTH = 10_000;

const NOTIFICATION_TYPES = ['ANNOUNCEMENT', 'ACADEMIC_UPDATE', 'EVENT', 'REMINDER', 'ALERT'] as const;
const NOTIFICATION_PRIORITIES = ['NORMAL', 'HIGH', 'URGENT'] as const;
const NOTIFICATION_TARGET_TYPES = ['ALL_STUDENTS', 'COURSE', 'INDIVIDUAL_STUDENTS'] as const;

type NotificationType = (typeof NOTIFICATION_TYPES)[number];
type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];
type NotificationTargetType = (typeof NOTIFICATION_TARGET_TYPES)[number];

export interface CreateNotificationInput {
  title?: unknown;
  body?: unknown;
  type?: unknown;
  priority?: unknown;
  targetType?: unknown;
  targetCourseId?: unknown;
  studentUserIds?: unknown;
  scheduledAt?: unknown;
}

export interface NotificationListFilters {
  status?: unknown;
  type?: unknown;
  priority?: unknown;
  targetType?: unknown;
  page?: unknown;
  limit?: unknown;
}

export interface StudentNotificationFilters {
  page?: unknown;
  limit?: unknown;
  unreadOnly?: unknown;
}

type ServiceError = Error & { statusCode: number };

function serviceError(statusCode: number, message: string): ServiceError {
  const error = new Error(message) as ServiceError;
  error.statusCode = statusCode;
  return error;
}

function academyIdFrom(context: TenantContext): string {
  if (!context.academyId) {
    throw serviceError(400, 'Missing active academy context.');
  }
  return context.academyId;
}

function isUuid(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
}

async function auditActorId(rawActorId?: string): Promise<string | null> {
  if (!isUuid(rawActorId)) return null;
  const actor = await prisma.user.findUnique({ where: { id: rawActorId }, select: { id: true } });
  return actor?.id ?? null;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseEnum<T extends readonly string[]>(value: unknown, valid: T, field: string, fallback: T[number]): T[number] {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !valid.includes(value)) {
    throw serviceError(422, `Invalid ${field}.`);
  }
  return value as T[number];
}

function parsePagination(pageValue: unknown, limitValue: unknown) {
  const page = Math.max(1, Number.parseInt(String(pageValue ?? '1'), 10) || 1);
  const requestedLimit = Number.parseInt(String(limitValue ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT;
  return { page, limit: Math.min(MAX_LIMIT, Math.max(1, requestedLimit)) };
}

function parseFutureTimestamp(value: unknown, required = false): Date | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw serviceError(422, 'A future scheduledAt timestamp is required.');
    return null;
  }
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
    throw serviceError(422, 'scheduledAt must be a valid future timestamp.');
  }
  return parsed;
}

function parseStudentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = [...new Set(value.filter((id): id is string => typeof id === 'string' && isUuid(id)))];
  if (ids.length !== value.length) throw serviceError(422, 'studentUserIds must contain valid user IDs only.');
  if (ids.length > 1000) throw serviceError(422, 'A notification can target at most 1,000 individual students.');
  return ids;
}

function notificationSummary(notification: Prisma.NotificationGetPayload<Record<string, never>>) {
  return {
    id: notification.id,
    title: notification.title,
    body: notification.body,
    type: notification.type,
    priority: notification.priority,
    targetType: notification.targetType,
    targetCourseId: notification.targetCourseId,
    status: notification.status,
    scheduledAt: notification.scheduledAt?.toISOString() ?? null,
    sentAt: notification.sentAt?.toISOString() ?? null,
    totalRecipients: notification.totalRecipients,
    readCount: notification.readCount,
    readPercentage: notification.totalRecipients > 0
      ? Number(((notification.readCount / notification.totalRecipients) * 100).toFixed(2))
      : 0,
    createdAt: notification.createdAt.toISOString(),
    updatedAt: notification.updatedAt.toISOString(),
  };
}

async function validateTarget(
  academyId: string,
  targetType: NotificationTargetType,
  targetCourseId: unknown,
  studentUserIds: unknown,
) {
  const courseId = typeof targetCourseId === 'string' ? targetCourseId : null;
  const studentIds = parseStudentIds(studentUserIds);

  if (targetType === 'ALL_STUDENTS') {
    return { targetCourseId: null, studentUserIds: [] as string[] };
  }

  if (targetType === 'COURSE') {
    if (!courseId || !isUuid(courseId)) throw serviceError(422, 'COURSE notifications require a valid targetCourseId.');
    const course = await prisma.course.findFirst({
      where: { id: courseId, academyId, deletedAt: null },
      select: { id: true },
    });
    if (!course) throw serviceError(403, 'Target course is not available in this academy.');
    return { targetCourseId: course.id, studentUserIds: [] as string[] };
  }

  if (studentIds.length === 0) {
    throw serviceError(422, 'INDIVIDUAL_STUDENTS notifications require at least one studentUserId.');
  }
  const memberships = await prisma.academyMembership.findMany({
    where: {
      academyId,
      userId: { in: studentIds },
      role: 'ACADEMY_STUDENT',
      status: 'ACTIVE',
    },
    select: { userId: true },
  });
  if (memberships.length !== studentIds.length) {
    throw serviceError(403, 'One or more selected students are not active members of this academy.');
  }
  return { targetCourseId: null, studentUserIds: studentIds };
}

async function writeAudit(input: {
  action: string;
  academyId: string;
  actorId?: string | null;
  notificationId: string;
  description: string;
  metadata?: Record<string, unknown>;
}, database: Prisma.TransactionClient | typeof prisma = prisma) {
  await database.systemAuditLog.create({
    data: {
      action: input.action,
      entityType: 'Notification',
      entityId: input.notificationId,
      academyId: input.academyId,
      actorId: input.actorId ?? null,
      description: input.description,
      metadata: input.metadata as Prisma.InputJsonValue | undefined,
    },
  });
}

async function getOwnedNotification(academyId: string, notificationId: string, includeDeleted = false) {
  const notification = await prisma.notification.findFirst({
    where: { id: notificationId, academyId, ...(includeDeleted ? {} : { deletedAt: null }) },
  });
  if (!notification) throw serviceError(404, 'Notification not found.');
  return notification;
}

async function resolveIndividualTargetIds(notificationId: string): Promise<string[]> {
  const targets = await prisma.notificationIndividualTarget.findMany({ where: { notificationId }, select: { studentUserId: true }, take: 1000 });
  if (targets.length) return targets.map((target) => target.studentUserId);
  const legacyAudit = await prisma.systemAuditLog.findFirst({ where: { entityType: 'Notification', entityId: notificationId, action: 'NOTIFICATION_CREATED' }, orderBy: { occurredAt: 'asc' }, select: { metadata: true } });
  return parseStudentIds((legacyAudit?.metadata as { studentUserIds?: unknown } | null)?.studentUserIds);
}

async function resolveRecipients(notification: any): Promise<string[]> {
  if (notification.targetType === 'ALL_STUDENTS') {
    const members = await prisma.academyMembership.findMany({
      where: { academyId: notification.academyId, role: 'ACADEMY_STUDENT', status: 'ACTIVE' },
      select: { userId: true },
      take: 100_001,
    });
    if (members.length > 100_000) throw serviceError(422, 'Notification audience exceeds the 100,000 recipient safety limit.');
    return [...new Set(members.map((member) => member.userId))];
  }

  if (notification.targetType === 'COURSE') {
    if (!notification.targetCourseId) throw serviceError(422, 'Notification has no target course.');
    const enrollments = await prisma.academyCourseEnrollment.findMany({
      where: {
        academyId: notification.academyId,
        courseId: notification.targetCourseId,
        status: 'ACTIVE',
        student: { academyMemberships: { some: { academyId: notification.academyId, role: 'ACADEMY_STUDENT', status: 'ACTIVE' } } },
      },
      select: { studentId: true },
      take: 100_001,
    });
    if (enrollments.length > 100_000) throw serviceError(422, 'Notification audience exceeds the 100,000 recipient safety limit.');
    return [...new Set(enrollments.map((enrollment) => enrollment.studentId))];
  }

  const studentIds = await resolveIndividualTargetIds(notification.id);
  if (studentIds.length === 0) throw serviceError(422, 'Notification has no valid individual student recipients.');
  const memberships = await prisma.academyMembership.findMany({
    where: { academyId: notification.academyId, userId: { in: studentIds }, role: 'ACADEMY_STUDENT', status: 'ACTIVE' },
    select: { userId: true },
  });
  if (memberships.length !== studentIds.length) {
    throw serviceError(403, 'One or more notification recipients are no longer active academy students.');
  }
  return studentIds;
}

function recipientChunks(studentUserIds: string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < studentUserIds.length; index += RECIPIENT_BATCH_SIZE) {
    chunks.push(studentUserIds.slice(index, index + RECIPIENT_BATCH_SIZE));
  }
  return chunks;
}

export async function createNotification(context: TenantContext, payload: CreateNotificationInput) {
  const academyId = academyIdFrom(context);
  const title = cleanString(payload.title);
  const body = cleanString(payload.body);
  if (!title || title.length > TITLE_MAX_LENGTH) throw serviceError(422, `title is required and must be at most ${TITLE_MAX_LENGTH} characters.`);
  if (!body || body.length > BODY_MAX_LENGTH) throw serviceError(422, `body is required and must be at most ${BODY_MAX_LENGTH} characters.`);

  const type = parseEnum(payload.type, NOTIFICATION_TYPES, 'type', 'ANNOUNCEMENT');
  const priority = parseEnum(payload.priority, NOTIFICATION_PRIORITIES, 'priority', 'NORMAL');
  const targetType = parseEnum(payload.targetType, NOTIFICATION_TARGET_TYPES, 'targetType', 'ALL_STUDENTS');
  const scheduledAt = parseFutureTimestamp(payload.scheduledAt);
  const target = await validateTarget(academyId, targetType, payload.targetCourseId, payload.studentUserIds);
  const actorId = await auditActorId(context.user.id);
  if (!actorId) throw serviceError(401, 'Authenticated sender account is unavailable.');

  return prisma.$transaction(async (transaction) => {
    const notification = await transaction.notification.create({ data: {
      academyId,
      senderId: actorId,
      title,
      body,
      type,
      priority,
      targetType,
      targetCourseId: target.targetCourseId,
      scheduledAt,
      status: scheduledAt ? 'SCHEDULED' : 'DRAFT',
    } });
    if (target.studentUserIds.length) await transaction.notificationIndividualTarget.createMany({ data: target.studentUserIds.map((studentUserId) => ({ notificationId: notification.id, academyId, studentUserId })) });
    await writeAudit({
    action: 'NOTIFICATION_CREATED',
    academyId,
    actorId,
    notificationId: notification.id,
    description: `Created notification ${notification.title}`,
    metadata: { targetType, targetCourseId: target.targetCourseId, studentUserIds: target.studentUserIds },
    }, transaction);
    if (scheduledAt) await writeAudit({
      action: 'NOTIFICATION_SCHEDULED', academyId, actorId, notificationId: notification.id,
      description: `Scheduled notification ${notification.title}`, metadata: { scheduledAt: scheduledAt.toISOString() },
    }, transaction);
    if (scheduledAt) await enqueueJob({ kind: 'NOTIFICATION_DISPATCH', payload: { notificationId: notification.id, academyId }, academyId, createdById: actorId, runAt: scheduledAt, deduplicationKey: notification.id }, transaction);
    return notificationSummary(notification);
  });
}

export async function listNotifications(context: TenantContext, filters: NotificationListFilters) {
  const academyId = academyIdFrom(context);
  const { page, limit } = parsePagination(filters.page, filters.limit);
  const status = filters.status === undefined ? undefined : parseEnum(filters.status, ['DRAFT', 'SCHEDULED', 'PROCESSING', 'SENT', 'CANCELLED'] as const, 'status', 'DRAFT');
  const type = filters.type === undefined ? undefined : parseEnum(filters.type, NOTIFICATION_TYPES, 'type', 'ANNOUNCEMENT');
  const priority = filters.priority === undefined ? undefined : parseEnum(filters.priority, NOTIFICATION_PRIORITIES, 'priority', 'NORMAL');
  const targetType = filters.targetType === undefined ? undefined : parseEnum(filters.targetType, NOTIFICATION_TARGET_TYPES, 'targetType', 'ALL_STUDENTS');
  const where: Prisma.NotificationWhereInput = { academyId, deletedAt: null, ...(status ? { status } : {}), ...(type ? { type } : {}), ...(priority ? { priority } : {}), ...(targetType ? { targetType } : {}) };
  const [total, notifications] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
  ]);
  return { data: notifications.map(notificationSummary), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getNotification(context: TenantContext, notificationId: string) {
  return notificationSummary(await getOwnedNotification(academyIdFrom(context), notificationId));
}

export async function updateNotification(context: TenantContext, notificationId: string, payload: CreateNotificationInput) {
  const academyId = academyIdFrom(context);
  const existing = await getOwnedNotification(academyId, notificationId);
  if (existing.status !== 'DRAFT' && existing.status !== 'SCHEDULED') throw serviceError(409, 'Only draft or scheduled notifications can be edited.');
  const data: Record<string, unknown> = {};
  if (payload.title !== undefined) {
    const title = cleanString(payload.title);
    if (!title || title.length > TITLE_MAX_LENGTH) throw serviceError(422, `title is required and must be at most ${TITLE_MAX_LENGTH} characters.`);
    data.title = title;
  }
  if (payload.body !== undefined) {
    const body = cleanString(payload.body);
    if (!body || body.length > BODY_MAX_LENGTH) throw serviceError(422, `body is required and must be at most ${BODY_MAX_LENGTH} characters.`);
    data.body = body;
  }
  if (payload.type !== undefined) data.type = parseEnum(payload.type, NOTIFICATION_TYPES, 'type', 'ANNOUNCEMENT');
  if (payload.priority !== undefined) data.priority = parseEnum(payload.priority, NOTIFICATION_PRIORITIES, 'priority', 'NORMAL');
  if (payload.scheduledAt !== undefined) {
    const scheduledAt = parseFutureTimestamp(payload.scheduledAt);
    data.scheduledAt = scheduledAt;
    data.status = scheduledAt ? 'SCHEDULED' : 'DRAFT';
  }
  if (payload.targetType !== undefined || payload.targetCourseId !== undefined || payload.studentUserIds !== undefined) {
    throw serviceError(409, 'Notification targeting cannot be changed after creation. Create a new draft instead.');
  }
  return prisma.$transaction(async (transaction) => {
    const updated = await transaction.notification.update({ where: { id: existing.id }, data });
    await writeAudit({ action: 'NOTIFICATION_UPDATED', academyId, actorId: await auditActorId(context.user.id), notificationId, description: `Updated notification ${updated.title}.` }, transaction);
    if (updated.status === 'SCHEDULED' && existing.status !== 'SCHEDULED') await writeAudit({ action: 'NOTIFICATION_SCHEDULED', academyId, actorId: await auditActorId(context.user.id), notificationId, description: `Scheduled notification ${updated.title}`, metadata: { scheduledAt: updated.scheduledAt?.toISOString() } }, transaction);
    return notificationSummary(updated);
  });
}

export async function scheduleNotification(context: TenantContext, notificationId: string, scheduledAtValue: unknown) {
  const academyId = academyIdFrom(context);
  const existing = await getOwnedNotification(academyId, notificationId);
  if (existing.status !== 'DRAFT' && existing.status !== 'SCHEDULED') throw serviceError(409, 'Only draft or scheduled notifications can be scheduled.');
  const scheduledAt = parseFutureTimestamp(scheduledAtValue, true)!;
  return prisma.$transaction(async (transaction) => {
    const updated = await transaction.notification.update({ where: { id: existing.id }, data: { status: 'SCHEDULED', scheduledAt, lastDispatchError: null } });
    await writeAudit({ action: 'NOTIFICATION_SCHEDULED', academyId, actorId: await auditActorId(context.user.id), notificationId, description: `Scheduled notification ${updated.title}`, metadata: { scheduledAt: scheduledAt.toISOString() } }, transaction);
    await enqueueJob({ kind: 'NOTIFICATION_DISPATCH', payload: { notificationId, academyId }, academyId, createdById: context.user.id, runAt: scheduledAt, deduplicationKey: notificationId }, transaction);
    return notificationSummary(updated);
  });
}

async function markProcessing(academyId: string, notificationId: string, fromStatus: 'DRAFT' | 'SCHEDULED') {
  const result = await prisma.notification.updateMany({
    where: { id: notificationId, academyId, status: fromStatus, deletedAt: null },
    data: { status: 'PROCESSING', processingStartedAt: new Date(), dispatchAttempts: { increment: 1 }, lastDispatchError: null },
  });
  if (result.count !== 1) throw serviceError(409, 'Notification is no longer available for dispatch.');
}

async function recoverProcessing(notification: any) {
  await prisma.notification.updateMany({
    where: { id: notification.id, status: 'PROCESSING', deletedAt: null },
    data: { status: notification.scheduledAt ? 'SCHEDULED' : 'DRAFT', processingStartedAt: null, lastDispatchError: 'IN_APP_RECIPIENT_EXPANSION_FAILED' },
  });
}

export async function dispatchNotification(notificationId: string, options: { academyId?: string; actorId?: string | null } = {}) {
  const notification = await prisma.notification.findFirst({ where: { id: notificationId, deletedAt: null } });
  if (!notification) throw serviceError(404, 'Notification not found.');
  if (options.academyId && notification.academyId !== options.academyId) throw serviceError(404, 'Notification not found.');
  if (notification.status !== 'PROCESSING') throw serviceError(409, 'Notification is not processing.');
  try {
    const studentUserIds = await resolveRecipients(notification);
    const updated = await prisma.$transaction(async (transaction) => {
      for (const chunk of recipientChunks(studentUserIds)) await transaction.notificationRecipient.createMany({
        data: chunk.map((studentUserId) => ({ notificationId: notification.id, academyId: notification.academyId, studentUserId })),
        skipDuplicates: true,
      });
      const sentAt = new Date();
      const sent = await transaction.notification.update({
      where: { id: notification.id },
      data: { status: 'SENT', totalRecipients: studentUserIds.length, readCount: 0, sentAt, processingStartedAt: null, lastDispatchError: null },
      });
      await writeAudit({
      action: 'NOTIFICATION_SENT', academyId: notification.academyId, actorId: options.actorId ?? null,
      notificationId: notification.id, description: `Sent notification ${notification.title}`,
      metadata: { totalRecipients: studentUserIds.length, sentAt: sentAt.toISOString(), deliveryChannel: 'IN_APP' },
      }, transaction);
      return sent;
    });
    await recordInAppDeliveries(notification.id, notification.academyId, studentUserIds);
    await fanoutAcademyNotificationToMobile(notification.id, studentUserIds);
    return notificationSummary(updated);
  } catch (error) {
    await recoverProcessing(notification);
    throw error;
  }
}

export async function sendNotification(context: TenantContext, notificationId: string, channels: DeliveryChannel[] = ['IN_APP']) {
  const academyId = academyIdFrom(context);
  assertChannelsConfigured(channels);
  const notification = await getOwnedNotification(academyId, notificationId);
  if (notification.status !== 'DRAFT') throw serviceError(409, 'Only draft notifications can be sent.');
  await markProcessing(academyId, notificationId, 'DRAFT');
  const result = await dispatchNotification(notificationId, { academyId, actorId: await auditActorId(context.user.id) });
  if (channels.includes('EMAIL')) {
    const recipients = await prisma.notificationRecipient.findMany({ where: { notificationId, studentUserId: { not: null } }, select: { studentUserId: true }, take: 50_001 });
    if (recipients.length > 50_000) throw serviceError(422, 'Email delivery exceeds the 50,000 recipient safety limit.');
    const delivery = await deliverEmails(notificationId, academyId, recipients.flatMap((recipient) => recipient.studentUserId ? [recipient.studentUserId] : []));
    return { ...result, channels: { inApp: result.totalRecipients, emailDelivered: delivery.filter((item) => item.delivered).length, emailFailed: delivery.filter((item) => !item.delivered).length } };
  }
  return { ...result, channels: { inApp: result.totalRecipients } };
}

export async function dispatchQueuedNotification(notificationId: string, academyId: string, actorId?: string) {
  const notification = await getOwnedNotification(academyId, notificationId);
  if (notification.status === 'SENT') return notificationSummary(notification);
  if (notification.status !== 'DRAFT') throw serviceError(409, 'Queued notification is not a dispatchable draft.');
  await markProcessing(academyId, notificationId, 'DRAFT');
  return dispatchNotification(notificationId, { academyId, actorId });
}

export async function cancelNotification(context: TenantContext, notificationId: string) {
  const academyId = academyIdFrom(context);
  const notification = await getOwnedNotification(academyId, notificationId);
  if (notification.status !== 'DRAFT' && notification.status !== 'SCHEDULED') throw serviceError(409, 'Only draft or scheduled notifications can be cancelled.');
  return prisma.$transaction(async (transaction) => {
    const updated = await transaction.notification.update({ where: { id: notification.id }, data: { status: 'CANCELLED' } });
    await transaction.backgroundJob.updateMany({ where: { kind: 'NOTIFICATION_DISPATCH', deduplicationKey: notificationId, status: { in: ['PENDING', 'PROCESSING'] } }, data: { status: 'CANCELLED', lockedAt: null, lockedBy: null } });
    await writeAudit({ action: 'NOTIFICATION_CANCELLED', academyId, actorId: await auditActorId(context.user.id), notificationId, description: `Cancelled notification ${updated.title}` }, transaction);
    return notificationSummary(updated);
  });
}

export async function deleteNotification(context: TenantContext, notificationId: string) {
  const academyId = academyIdFrom(context);
  const notification = await getOwnedNotification(academyId, notificationId);
  if (notification.status === 'PROCESSING' || notification.status === 'SENT') throw serviceError(409, 'Sent or processing notifications cannot be deleted.');
  return prisma.$transaction(async (transaction) => {
    const updated = await transaction.notification.update({ where: { id: notification.id }, data: { deletedAt: new Date() } });
    await writeAudit({ action: 'NOTIFICATION_DELETED', academyId, actorId: await auditActorId(context.user.id), notificationId, description: `Deleted notification ${notification.title}` }, transaction);
    return { id: updated.id, deletedAt: updated.deletedAt?.toISOString() ?? null };
  });
}

export async function runScheduledNotificationsOnce() {
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const stale = await prisma.notification.findMany({ where: { status: 'PROCESSING', processingStartedAt: { lt: staleBefore }, deletedAt: null }, select: { id: true, scheduledAt: true }, take: 50 });
  for (const notification of stale) await recoverProcessing(notification);
  const due = await prisma.notification.findMany({
    where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() }, deletedAt: null },
    orderBy: { scheduledAt: 'asc' }, take: 50, select: { id: true, academyId: true },
  });
  const results: Array<{ notificationId: string; dispatched: boolean }> = [];
  for (const notification of due) {
    const claimed = await prisma.notification.updateMany({
      where: { id: notification.id, academyId: notification.academyId, status: 'SCHEDULED', deletedAt: null },
      data: { status: 'PROCESSING', processingStartedAt: new Date(), dispatchAttempts: { increment: 1 }, lastDispatchError: null },
    });
    if (claimed.count !== 1) continue;
    try {
      await dispatchNotification(notification.id, { academyId: notification.academyId });
      results.push({ notificationId: notification.id, dispatched: true });
    } catch {
      results.push({ notificationId: notification.id, dispatched: false });
    }
  }
  return results;
}

export async function getStudentNotifications(studentUserId: string, filters: StudentNotificationFilters) {
  if (!isUuid(studentUserId)) throw serviceError(401, 'Authenticated student is required.');
  const { page, limit } = parsePagination(filters.page, filters.limit);
  const unreadOnly = filters.unreadOnly === true || filters.unreadOnly === 'true';
  const where: Prisma.NotificationRecipientWhereInput = { studentUserId, ...(unreadOnly ? { isRead: false } : {}), notification: { status: 'SENT', deletedAt: null } };
  const [total, rows] = await Promise.all([
    prisma.notificationRecipient.count({ where }),
    prisma.notificationRecipient.findMany({ where, include: { notification: true }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
  ]);
  return {
    data: rows.map((row) => ({ id: row.notification.id, title: row.notification.title, body: row.notification.body, type: row.notification.type, priority: row.notification.priority, sentAt: row.notification.sentAt?.toISOString() ?? null, isRead: row.isRead, readAt: row.readAt?.toISOString() ?? null })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getStudentUnreadCount(studentUserId: string) {
  if (!isUuid(studentUserId)) throw serviceError(401, 'Authenticated student is required.');
  const count = await prisma.notificationRecipient.count({ where: { studentUserId, isRead: false, notification: { status: 'SENT', deletedAt: null } } });
  return { count };
}

export async function markStudentNotificationRead(studentUserId: string, notificationId: string) {
  if (!isUuid(studentUserId)) throw serviceError(401, 'Authenticated student is required.');
  return prisma.$transaction(async (tx) => {
    const recipient = await tx.notificationRecipient.findFirst({
      where: { notificationId, studentUserId, notification: { status: 'SENT', deletedAt: null } },
      select: { id: true, notificationId: true, isRead: true, readAt: true },
    });
    if (!recipient) throw serviceError(404, 'Notification not found.');
    if (recipient.isRead) return { notificationId, isRead: true, readAt: recipient.readAt?.toISOString() ?? null };
    const readAt = new Date();
    const changed = await tx.notificationRecipient.updateMany({ where: { id: recipient.id, isRead: false }, data: { isRead: true, readAt } });
    if (changed.count === 1) {
      await tx.notification.updateMany({ where: { id: recipient.notificationId, deletedAt: null }, data: { readCount: { increment: 1 } } });
    }
    return { notificationId, isRead: true, readAt: readAt.toISOString() };
  });
}

export const notificationInternals = { recipientChunks, resolveRecipients, RECIPIENT_BATCH_SIZE };
