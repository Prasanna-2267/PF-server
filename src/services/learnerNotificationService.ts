import { Prisma, type LearnerNotificationCategory, type MobilePushPlatform } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { badRequest, notFound } from "../errors/api-error.js";
import { getPushProvider } from "../integrations/provider-registry.js";
import { enqueueJob } from "./backgroundJobService.js";
import { databaseDate, learnerDateKey } from "./learnerTime.js";

const PUSH_BATCH_SIZE = 100;
const DEFAULT_PREFERENCES = {
  pushEnabled: true, broadcastEnabled: true, dailyPlanEnabled: true, revisionDueEnabled: false,
  resourceExpiryEnabled: false, streakRiskEnabled: true, securityEnabled: true, accountEnabled: true,
  quietHoursEnabled: false, quietHoursStart: "22:00", quietHoursEnd: "07:00",
};

type PreferenceKey = "broadcastEnabled" | "dailyPlanEnabled" | "revisionDueEnabled" | "resourceExpiryEnabled" | "streakRiskEnabled" | "securityEnabled" | "accountEnabled";
const preferenceKey: Record<LearnerNotificationCategory, PreferenceKey> = {
  BROADCAST: "broadcastEnabled", DAILY_PLAN: "dailyPlanEnabled", REVISION_DUE: "revisionDueEnabled",
  RESOURCE_EXPIRY: "resourceExpiryEnabled", STREAK_RISK: "streakRiskEnabled", SECURITY: "securityEnabled", ACCOUNT: "accountEnabled",
};

const validTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const timeParts = (date: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return `${parts.find((part) => part.type === "hour")?.value}:${parts.find((part) => part.type === "minute")?.value}`;
};
const isQuiet = (time: string, start: string, end: string) => start < end ? time >= start && time < end : time >= start || time < end;

type NotificationDbClient = Prisma.TransactionClient | typeof prisma;

async function effectiveScheduledFor(userId: string, category: LearnerNotificationCategory, requested: Date, client: NotificationDbClient) {
  if (category === "SECURITY") return requested;
  const [preference, learner] = await Promise.all([
    client.learnerNotificationPreference.findUnique({ where: { userId } }),
    client.learnerPreference.findUnique({ where: { userId }, select: { timezone: true } }),
  ]);
  if (!preference?.quietHoursEnabled) return requested;
  const timezone = learner?.timezone ?? "Asia/Kolkata";
  if (!isQuiet(timeParts(requested, timezone), preference.quietHoursStart, preference.quietHoursEnd)) return requested;
  for (let minute = 1; minute <= 24 * 60; minute += 1) {
    const candidate = new Date(requested.getTime() + minute * 60_000);
    if (!isQuiet(timeParts(candidate, timezone), preference.quietHoursStart, preference.quietHoursEnd)) return candidate;
  }
  return new Date(requested.getTime() + 8 * 60 * 60_000);
}

export async function registerPushToken(userId: string, input: { token: string; platform: MobilePushPlatform; installationId: string; deviceName?: string; appVersion?: string }) {
  if (!/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(input.token)) throw badRequest("INVALID_EXPO_PUSH_TOKEN", "A valid Expo push token is required.");
  const tokenOwnedElsewhere = await prisma.mobilePushToken.findUnique({ where: { token: input.token }, select: { userId: true } });
  if (tokenOwnedElsewhere && tokenOwnedElsewhere.userId !== userId) throw badRequest("PUSH_TOKEN_ALREADY_REGISTERED", "This push token belongs to another account.");
  return prisma.mobilePushToken.upsert({
    where: { userId_installationId: { userId, installationId: input.installationId } },
    create: { userId, ...input },
    update: { token: input.token, platform: input.platform, deviceName: input.deviceName, appVersion: input.appVersion, enabled: true, revokedAt: null, lastSeenAt: new Date(), consecutiveErrors: 0, lastError: null },
    select: { id: true, platform: true, installationId: true, enabled: true, lastSeenAt: true },
  });
}

export async function revokePushToken(userId: string, installationId: string) {
  await prisma.mobilePushToken.updateMany({ where: { userId, installationId }, data: { enabled: false, revokedAt: new Date() } });
  return { installationId, revoked: true };
}

export async function getNotificationPreferences(userId: string, client: NotificationDbClient = prisma) {
  return (await client.learnerNotificationPreference.findUnique({ where: { userId } })) ?? { userId, ...DEFAULT_PREFERENCES };
}

export async function patchNotificationPreferences(userId: string, input: Partial<typeof DEFAULT_PREFERENCES>) {
  if (input.quietHoursStart !== undefined && !validTime(input.quietHoursStart)) throw badRequest("INVALID_QUIET_HOURS", "quietHoursStart must use HH:mm.");
  if (input.quietHoursEnd !== undefined && !validTime(input.quietHoursEnd)) throw badRequest("INVALID_QUIET_HOURS", "quietHoursEnd must use HH:mm.");
  return prisma.$transaction(async (transaction) => {
    const preferences = await transaction.learnerNotificationPreference.upsert({ where: { userId }, create: { userId, ...DEFAULT_PREFERENCES, ...input }, update: input });
    if (input.pushEnabled === false) {
      await transaction.learnerNotificationPushDelivery.updateMany({
        where: { status: { in: ["PENDING", "FAILED"] }, pushToken: { userId } },
        data: { status: "CANCELLED", nextAttemptAt: null, lastError: "PUSH_DISABLED_BY_LEARNER" },
      });
    }
    return preferences;
  });
}

export async function createLearnerNotification(input: { userId: string; category: LearnerNotificationCategory; title: string; body: string; sourceKey: string; data?: Record<string, unknown>; scheduledFor?: Date; required?: boolean }, client: NotificationDbClient = prisma) {
  const preferences = await getNotificationPreferences(input.userId, client);
  if (!input.required && !preferences[preferenceKey[input.category]]) return null;
  const scheduledFor = input.required ? (input.scheduledFor ?? new Date()) : await effectiveScheduledFor(input.userId, input.category, input.scheduledFor ?? new Date(), client);
  const notification = await client.learnerNotification.upsert({
    where: { userId_sourceKey: { userId: input.userId, sourceKey: input.sourceKey } },
    create: { userId: input.userId, category: input.category, title: input.title, body: input.body, sourceKey: input.sourceKey, data: input.data as Prisma.InputJsonValue | undefined, scheduledFor },
    update: {},
  });
  if (preferences.pushEnabled) {
    const tokens = await client.mobilePushToken.findMany({ where: { userId: input.userId, enabled: true, revokedAt: null }, select: { id: true } });
    if (tokens.length) await client.learnerNotificationPushDelivery.createMany({ data: tokens.map((token) => ({ notificationId: notification.id, pushTokenId: token.id })), skipDuplicates: true });
  }
  return notification;
}

export async function fanoutAcademyNotificationToMobile(notificationId: string, studentUserIds: string[]) {
  const notification = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId }, select: { title: true, body: true, priority: true } });
  let created = 0;
  for (const userId of [...new Set(studentUserIds)]) {
    const row = await createLearnerNotification({ userId, category: "BROADCAST", title: notification.title, body: notification.body, sourceKey: `academy-notification:${notificationId}`, data: { url: "/(student)/(tabs)/home", academyNotificationId: notificationId, priority: notification.priority } });
    if (row) created += 1;
  }
  if (created) await enqueueJob({ kind: "LEARNER_PUSH_DELIVERY", payload: { sourceKey: `academy-notification:${notificationId}` }, deduplicationKey: `academy-notification:${notificationId}` });
  return { created };
}

export async function fanoutPlatformBroadcastToUnaffiliatedLearners(broadcastId: string) {
  const broadcast = await prisma.broadcast.findFirst({ where: { id: broadcastId, academyId: null, status: "ACTIVE", deletedAt: null }, include: { academyTargets: { select: { academyId: true } } } });
  if (!broadcast || broadcast.academyTargets.length) return { created: 0 };
  const learners = await prisma.user.findMany({ where: { status: "ACTIVE", deletedAt: null, role: { key: "student", isActive: true }, academyMemberships: { none: { role: "ACADEMY_STUDENT", status: "ACTIVE" } } }, select: { id: true }, take: 100_001 });
  if (learners.length > 100_000) throw badRequest("BROADCAST_AUDIENCE_TOO_LARGE", "Unaffiliated broadcast audience exceeds the 100,000 learner safety limit.");
  let created = 0;
  for (const learner of learners) {
    const row = await createLearnerNotification({ userId: learner.id, category: "BROADCAST", title: broadcast.title, body: broadcast.message, sourceKey: `platform-broadcast:${broadcast.id}`, data: { url: "/(student)/(tabs)/home", broadcastId: broadcast.id, priority: broadcast.priority } });
    if (row) created += 1;
  }
  if (created) await enqueueJob({ kind: "LEARNER_PUSH_DELIVERY", payload: { sourceKey: `platform-broadcast:${broadcast.id}` }, deduplicationKey: `platform-broadcast:${broadcast.id}` });
  return { created };
}

export async function dispatchLearnerPushDeliveries(sourceKey?: string) {
  const due = await prisma.learnerNotificationPushDelivery.findMany({
    where: { status: { in: ["PENDING", "FAILED"] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }], notification: { scheduledFor: { lte: new Date() }, ...(sourceKey ? { sourceKey } : {}) }, pushToken: { enabled: true, revokedAt: null } },
    include: { notification: true, pushToken: true }, orderBy: { createdAt: "asc" }, take: 5_000,
  });
  let delivered = 0; let failed = 0;
  for (let offset = 0; offset < due.length; offset += PUSH_BATCH_SIZE) {
    const batch = due.slice(offset, offset + PUSH_BATCH_SIZE);
    await prisma.learnerNotificationPushDelivery.updateMany({ where: { id: { in: batch.map((row) => row.id) }, status: { in: ["PENDING", "FAILED"] } }, data: { status: "PROCESSING", attemptCount: { increment: 1 }, lastError: null } });
    try {
      const receipts = await getPushProvider().send(batch.map((row) => ({ to: row.pushToken.token, title: row.notification.title, body: row.notification.body, data: (row.notification.data as Record<string, unknown> | null) ?? {}, priority: row.notification.category === "SECURITY" ? "high" : "normal" })));
      for (let index = 0; index < batch.length; index += 1) {
        const row = batch[index]; const receipt = receipts[index];
        if (receipt?.delivered) {
          delivered += 1;
          await prisma.learnerNotificationPushDelivery.update({ where: { id: row.id }, data: { status: "DELIVERED", deliveredAt: new Date(), providerMessageId: receipt.providerMessageId } });
          await prisma.mobilePushToken.update({ where: { id: row.pushTokenId }, data: { consecutiveErrors: 0, lastError: null } });
        } else {
          failed += 1; const message = receipt?.error ?? "PUSH_PROVIDER_REJECTED";
          await prisma.learnerNotificationPushDelivery.update({ where: { id: row.id }, data: { status: "FAILED", lastError: message, nextAttemptAt: new Date(Date.now() + 5 * 60_000) } });
          await prisma.mobilePushToken.update({ where: { id: row.pushTokenId }, data: { consecutiveErrors: { increment: 1 }, lastError: message, ...(receipt?.deviceNotRegistered ? { enabled: false, revokedAt: new Date() } : {}) } });
        }
      }
    } catch (error) {
      failed += batch.length;
      await prisma.learnerNotificationPushDelivery.updateMany({ where: { id: { in: batch.map((row) => row.id) }, status: "PROCESSING" }, data: { status: "FAILED", lastError: error instanceof Error ? error.message.slice(0, 1_000) : "PUSH_PROVIDER_FAILED", nextAttemptAt: new Date(Date.now() + 5 * 60_000) } });
    }
  }
  return { attempted: due.length, delivered, failed };
}

export async function listLearnerNotifications(userId: string, input: { page: number; limit: number; unreadOnly: boolean }) {
  const where: Prisma.LearnerNotificationWhereInput = { userId, scheduledFor: { lte: new Date() }, ...(input.unreadOnly ? { readAt: null } : {}) };
  const [total, data] = await Promise.all([prisma.learnerNotification.count({ where }), prisma.learnerNotification.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (input.page - 1) * input.limit, take: input.limit })]);
  return { data, pagination: { ...input, total, totalPages: Math.ceil(total / input.limit) } };
}

export async function markLearnerNotificationRead(userId: string, id: string) {
  const changed = await prisma.learnerNotification.updateMany({ where: { id, userId }, data: { readAt: new Date() } });
  if (!changed.count) throw notFound("LEARNER_NOTIFICATION_NOT_FOUND", "Notification not found.");
  return prisma.learnerNotification.findUniqueOrThrow({ where: { id } });
}

export async function runLearnerReminderSweep(now = new Date()) {
  const learners = await prisma.learnerPreference.findMany({ where: { user: { status: "ACTIVE", deletedAt: null } }, select: { userId: true, timezone: true, reminderTime: true }, take: 20_000 });
  let created = 0;
  for (const learner of learners) {
    const localDate = learnerDateKey(now, learner.timezone); const localTime = timeParts(now, learner.timezone);
    if (localTime < learner.reminderTime || localTime >= "23:59") continue;
    const plan = await prisma.learnerStudyPlan.findUnique({ where: { userId_localDate: { userId: learner.userId, localDate: databaseDate(localDate) } }, select: { tasks: { where: { hiddenAt: null, status: { in: ["PLANNED", "IN_PROGRESS"] } }, select: { id: true }, take: 1 } } });
    if (plan?.tasks.length && await createLearnerNotification({ userId: learner.userId, category: "DAILY_PLAN", title: "Your study plan is waiting", body: "A focused task is ready for today.", sourceKey: `daily-plan:${localDate}`, data: { url: "/(student)/(tabs)/home" } })) created += 1;
    const streakDay = await prisma.learnerStreakDay.findUnique({ where: { userId_localDate: { userId: learner.userId, localDate: databaseDate(localDate) } }, select: { status: true } });
    if (!streakDay && await createLearnerNotification({ userId: learner.userId, category: "STREAK_RISK", title: "Protect today’s streak", body: "Complete a focus session before the day ends.", sourceKey: `streak-risk:${localDate}`, data: { url: "/(student)/(tabs)/tracker" } })) created += 1;
  }
  if (created) await enqueueJob({ kind: "LEARNER_PUSH_DELIVERY", payload: {}, deduplicationKey: `reminders:${now.toISOString().slice(0, 13)}` });
  return { scanned: learners.length, created };
}
