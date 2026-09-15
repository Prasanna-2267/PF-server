import { Prisma, type FocusSessionSource } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { badRequest, conflict, notFound } from "../errors/api-error.js";
import { createRewardClaim } from "./rewardService.js";
import { databaseDate, databaseDateKey, learnerDateKey, splitFocusSeconds } from "./learnerTime.js";
import { recalculateStreakState, recordQualifiedStreakDay } from "./streakService.js";

const MINIMUM_STREAK_SECONDS = 60;
const MAXIMUM_CREDITED_SECONDS = 86_400;
const DAILY_FOCUS_POLICY_VERSION = "daily-focus-v1";

async function preference(userId: string, database: Prisma.TransactionClient | typeof prisma = prisma) {
  return (await database.learnerPreference.findUnique({ where: { userId }, select: { timezone: true, dailyTargetMinutes: true } })) ?? { timezone: "Asia/Kolkata", dailyTargetMinutes: 120 };
}

function activeProjection(session: { id: string; source: FocusSessionSource; sourceId: string | null; plannedDurationSeconds: number | null; status: string; startedAt: Date; lastHeartbeatAt: Date; checkedOutAt: Date | null; abandonedAt: Date | null; durationSeconds: number | null }, now = new Date()) {
  return { ...session, elapsedSeconds: session.status === "ACTIVE" ? Math.max(0, Math.floor((now.getTime() - session.startedAt.getTime()) / 1000)) : session.durationSeconds ?? 0, serverTime: now };
}

const sessionSelect = { id: true, source: true, sourceId: true, plannedDurationSeconds: true, status: true, startedAt: true, lastHeartbeatAt: true, checkedOutAt: true, abandonedAt: true, durationSeconds: true } satisfies Prisma.FocusSessionSelect;

export async function getActiveFocusSession(userId: string) {
  const now = new Date();
  const session = await prisma.focusSession.findFirst({ where: { userId, status: "ACTIVE" }, select: sessionSelect });
  return { session: session ? activeProjection(session, now) : null, serverTime: now };
}

export async function startFocusSession(userId: string, input: { source: FocusSessionSource; sourceId?: string; plannedDurationSeconds?: number }) {
  if ((input.source === "NOTE" || input.source === "STUDY_TASK") && !input.sourceId) throw badRequest("FOCUS_SOURCE_ID_REQUIRED", "This focus source requires its resource ID.");
  if ((input.source === "HOME" || input.source === "TRACKER") && input.sourceId) throw badRequest("FOCUS_SOURCE_ID_NOT_ALLOWED", "Home and Tracker focus sessions do not accept a resource ID.");
  const existing = await prisma.focusSession.findFirst({ where: { userId, status: "ACTIVE" }, select: sessionSelect });
  if (existing) return { created: false, session: activeProjection(existing) };
  try {
    const session = await prisma.focusSession.create({ data: { userId, source: input.source, sourceId: input.sourceId, plannedDurationSeconds: input.plannedDurationSeconds }, select: sessionSelect });
    return { created: true, session: activeProjection(session) };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await prisma.focusSession.findFirst({ where: { userId, status: "ACTIVE" }, select: sessionSelect });
      if (winner) return { created: false, session: activeProjection(winner) };
    }
    throw error;
  }
}

export async function heartbeatFocusSession(userId: string, sessionId: string) {
  const now = new Date();
  const updated = await prisma.focusSession.updateMany({ where: { id: sessionId, userId, status: "ACTIVE" }, data: { lastHeartbeatAt: now } });
  if (!updated.count) {
    const owned = await prisma.focusSession.findFirst({ where: { id: sessionId, userId }, select: sessionSelect });
    if (!owned) throw notFound("FOCUS_SESSION_NOT_FOUND", "The focus session was not found.");
    throw conflict("FOCUS_SESSION_NOT_ACTIVE", "This focus session is no longer active.");
  }
  const session = await prisma.focusSession.findUniqueOrThrow({ where: { id: sessionId }, select: sessionSelect });
  return { session: activeProjection(session, now) };
}

async function checkoutResult(userId: string, sessionId: string) {
  const session = await prisma.focusSession.findFirst({ where: { id: sessionId, userId }, select: sessionSelect });
  if (!session) throw notFound("FOCUS_SESSION_NOT_FOUND", "The focus session was not found.");
  const pref = await preference(userId);
  const checkoutDate = learnerDateKey(session.checkedOutAt ?? new Date(), pref.timezone);
  const [activity, streak, rewardClaim] = await Promise.all([
    prisma.learnerDailyActivity.findUnique({ where: { userId_localDate: { userId, localDate: databaseDate(checkoutDate) } } }),
    prisma.learnerStreakState.findUnique({ where: { userId } }),
    prisma.rewardClaim.findUnique({ where: { userId_sourceType_sourceId_policyVersion: { userId, sourceType: "DAILY_FOCUS", sourceId: checkoutDate, policyVersion: DAILY_FOCUS_POLICY_VERSION } }, select: { id: true, points: true, hearts: true, status: true, expiresAt: true } }),
  ]);
  return { session: activeProjection(session), dailyActivity: activity, streak: streak ?? { currentStreak: 0, longestStreak: 0, lastQualifiedDate: null }, rewardClaim };
}

async function checkoutOnce(userId: string, sessionId: string, idempotencyKey: string) {
  const keyOwner = await prisma.focusSession.findFirst({ where: { userId, checkoutIdempotencyKey: idempotencyKey }, select: { id: true } });
  if (keyOwner && keyOwner.id !== sessionId) throw conflict("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for another focus session.");
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const session = await tx.focusSession.findFirst({ where: { id: sessionId, userId } });
    if (!session) throw notFound("FOCUS_SESSION_NOT_FOUND", "The focus session was not found.");
    if (session.status === "COMPLETED") return;
    if (session.status !== "ACTIVE") throw conflict("FOCUS_SESSION_NOT_ACTIVE", "An abandoned focus session cannot be checked out.");
    const pref = await preference(userId, tx);
    const segments = splitFocusSeconds(session.startedAt, now, pref.timezone, MAXIMUM_CREDITED_SECONDS);
    for (const segment of segments) {
      const localDate = databaseDate(segment.localDate);
      const activity = await tx.learnerDailyActivity.upsert({
        where: { userId_localDate: { userId, localDate } },
        create: { userId, localDate, timezone: pref.timezone, targetMinutes: pref.dailyTargetMinutes, focusSeconds: segment.seconds, focusSessionCount: 1, lastActivityAt: now },
        update: { focusSeconds: { increment: segment.seconds }, focusSessionCount: { increment: 1 }, lastActivityAt: now },
      });
      const goalCompleted = activity.focusSeconds >= activity.targetMinutes * 60;
      const qualifiesStreak = goalCompleted;
      if (qualifiesStreak !== activity.qualifiesStreak || goalCompleted !== activity.goalCompleted) {
        await tx.learnerDailyActivity.update({ where: { userId_localDate: { userId, localDate } }, data: { qualifiesStreak, goalCompleted } });
      }
      if (qualifiesStreak) {
        await recordQualifiedStreakDay(tx, { userId, localDate: segment.localDate, timezone: pref.timezone, focusSeconds: activity.focusSeconds, targetMinutes: activity.targetMinutes, qualifiedAt: now });
      }
      if (activity.focusSeconds >= MINIMUM_STREAK_SECONDS) await createRewardClaim({ userId, sourceType: "DAILY_FOCUS", sourceId: segment.localDate, points: goalCompleted ? 20 : 10, policyVersion: DAILY_FOCUS_POLICY_VERSION, expiresAt: new Date(now.getTime() + 30 * 86_400_000) }, tx);
    }
    await tx.focusSession.update({ where: { id: session.id }, data: { status: "COMPLETED", checkedOutAt: now, durationSeconds: Math.min(MAXIMUM_CREDITED_SECONDS, Math.max(0, Math.floor((now.getTime() - session.startedAt.getTime()) / 1000))), checkoutIdempotencyKey: idempotencyKey } });
    await recalculateStreakState(tx, userId, pref.timezone, now);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return checkoutResult(userId, sessionId);
}

export async function checkoutFocusSession(userId: string, sessionId: string, idempotencyKey: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await checkoutOnce(userId, sessionId, idempotencyKey); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034") && attempt < 2) continue;
      throw error;
    }
  }
  return checkoutResult(userId, sessionId);
}

export async function abandonFocusSession(userId: string, sessionId: string) {
  const now = new Date();
  const session = await prisma.focusSession.findFirst({ where: { id: sessionId, userId }, select: sessionSelect });
  if (!session) throw notFound("FOCUS_SESSION_NOT_FOUND", "The focus session was not found.");
  if (session.status === "ABANDONED") return { session: activeProjection(session, now) };
  if (session.status === "COMPLETED") throw conflict("FOCUS_SESSION_ALREADY_COMPLETED", "A completed focus session cannot be abandoned.");
  const updated = await prisma.focusSession.update({ where: { id: sessionId }, data: { status: "ABANDONED", abandonedAt: now }, select: sessionSelect });
  return { session: activeProjection(updated, now) };
}

export async function listFocusSessions(userId: string, input: { cursor?: string; limit: number; source?: FocusSessionSource; from?: Date; to?: Date }) {
  const cursor = input.cursor ? await prisma.focusSession.findFirst({ where: { id: input.cursor, userId }, select: { id: true, startedAt: true } }) : null;
  if (input.cursor && !cursor) throw badRequest("INVALID_FOCUS_CURSOR", "The focus-session cursor is invalid.");
  const data = await prisma.focusSession.findMany({
    where: { userId, ...(input.source ? { source: input.source } : {}), ...(input.from || input.to ? { startedAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lt: input.to } : {}) } } : {}), ...(cursor ? { OR: [{ startedAt: { lt: cursor.startedAt } }, { startedAt: cursor.startedAt, id: { lt: cursor.id } }] } : {}) },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: input.limit + 1, select: sessionSelect,
  });
  const hasMore = data.length > input.limit;
  const page = hasMore ? data.slice(0, input.limit) : data;
  return { data: page.map((session) => activeProjection(session)), nextCursor: hasMore ? page.at(-1)!.id : null };
}

export async function getDailySummary(userId: string, localDate?: string) {
  const pref = await preference(userId);
  const date = localDate ?? learnerDateKey(new Date(), pref.timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(databaseDate(date).getTime()) || databaseDateKey(databaseDate(date)) !== date) throw badRequest("INVALID_ACTIVITY_DATE", "Date must be a valid YYYY-MM-DD value.");
  const activity = await prisma.learnerDailyActivity.findUnique({ where: { userId_localDate: { userId, localDate: databaseDate(date) } } });
  const targetMinutes = activity?.targetMinutes ?? pref.dailyTargetMinutes;
  return {
    date,
    timezone: activity?.timezone ?? pref.timezone,
    targetMinutes,
    focusSeconds: activity?.focusSeconds ?? 0,
    readingSeconds: activity?.readingSeconds ?? 0,
    practiceSeconds: activity?.practiceSeconds ?? 0,
    revisionSeconds: activity?.revisionSeconds ?? 0,
    focusSessionCount: activity?.focusSessionCount ?? 0,
    qualifiesStreak: activity?.qualifiesStreak ?? false,
    goalCompleted: activity?.goalCompleted ?? false,
    progressPercent: Math.min(100, Math.round(((activity?.focusSeconds ?? 0) / (targetMinutes * 60)) * 100)),
    lastActivityAt: activity?.lastActivityAt ?? null,
    serverTime: new Date(),
  };
}
