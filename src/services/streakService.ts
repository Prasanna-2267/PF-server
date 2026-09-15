import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { badRequest, conflict } from "../errors/api-error.js";
import { addLearnerDays, databaseDate, databaseDateKey, learnerDateKey, monthBounds } from "./learnerTime.js";
import { getRewardWallet, spendHeartInTransaction } from "./rewardService.js";

const RECOVERY_POLICY_VERSION = "heart-recovery-v1";

type Database = Prisma.TransactionClient | typeof prisma;

function calculateRuns(keys: string[], todayKey: string) {
  const unique = [...new Set(keys)].sort();
  const available = new Set(unique);
  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const key of unique) {
    run = previous && addLearnerDays(previous, 1) === key ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = key;
  }
  const yesterdayKey = addLearnerDays(todayKey, -1);
  let cursor = available.has(todayKey) ? todayKey : available.has(yesterdayKey) ? yesterdayKey : null;
  let current = 0;
  while (cursor && available.has(cursor)) {
    current += 1;
    cursor = addLearnerDays(cursor, -1);
  }
  return { current, longest, lastQualifiedDate: unique.at(-1) ?? null };
}

async function preference(userId: string, database: Database = prisma) {
  return (await database.learnerPreference.findUnique({ where: { userId }, select: { timezone: true, dailyTargetMinutes: true } })) ?? { timezone: "Asia/Kolkata", dailyTargetMinutes: 120 };
}

export async function recalculateStreakState(database: Database, userId: string, timezone: string, now = new Date()) {
  const rows = await database.learnerStreakDay.findMany({ where: { userId }, orderBy: { localDate: "asc" }, take: 5000, select: { localDate: true } });
  const calculated = calculateRuns(rows.map((row) => databaseDateKey(row.localDate)), learnerDateKey(now, timezone));
  const existing = await database.learnerStreakState.findUnique({ where: { userId }, select: { longestStreak: true } });
  return database.learnerStreakState.upsert({
    where: { userId },
    create: { userId, currentStreak: calculated.current, longestStreak: calculated.longest, lastQualifiedDate: calculated.lastQualifiedDate ? databaseDate(calculated.lastQualifiedDate) : null },
    update: { currentStreak: calculated.current, longestStreak: Math.max(existing?.longestStreak ?? 0, calculated.longest), lastQualifiedDate: calculated.lastQualifiedDate ? databaseDate(calculated.lastQualifiedDate) : null, version: { increment: 1 } },
  });
}

export async function recordQualifiedStreakDay(database: Database, input: { userId: string; localDate: string; timezone: string; focusSeconds: number; targetMinutes: number; qualifiedAt: Date }) {
  await database.learnerStreakDay.upsert({
    where: { userId_localDate: { userId: input.userId, localDate: databaseDate(input.localDate) } },
    create: { userId: input.userId, localDate: databaseDate(input.localDate), status: "ACTIVE", timezone: input.timezone, focusSeconds: input.focusSeconds, targetMinutes: input.targetMinutes, qualifiedAt: input.qualifiedAt },
    update: { focusSeconds: input.focusSeconds, targetMinutes: input.targetMinutes, qualifiedAt: input.qualifiedAt },
  });
}

async function snapshot(userId: string, now = new Date()) {
  const pref = await preference(userId);
  const todayKey = learnerDateKey(now, pref.timezone);
  const [days, stored, wallet] = await Promise.all([
    prisma.learnerStreakDay.findMany({ where: { userId }, orderBy: { localDate: "asc" }, take: 5000, select: { localDate: true, status: true } }),
    prisma.learnerStreakState.findUnique({ where: { userId }, select: { longestStreak: true } }),
    getRewardWallet(userId),
  ]);
  const calculated = calculateRuns(days.map((day) => databaseDateKey(day.localDate)), todayKey);
  const today = days.find((day) => databaseDateKey(day.localDate) === todayKey);
  return {
    currentStreak: calculated.current,
    longestStreak: Math.max(stored?.longestStreak ?? 0, calculated.longest),
    lastQualifiedDate: calculated.lastQualifiedDate,
    todayState: today?.status === "PROTECTED" ? "protected" as const : today ? "active" as const : "pending" as const,
    nextProtectionDeadline: new Date(now.getTime() + 48 * 60 * 60_000),
    hearts: wallet.hearts,
    heartCap: wallet.heartCap,
    timezone: pref.timezone,
    serverTime: now,
  };
}

export async function getStreak(userId: string) {
  return snapshot(userId);
}

export async function getStreakCalendar(userId: string, month: string) {
  let bounds: ReturnType<typeof monthBounds>;
  try { bounds = monthBounds(month); } catch { throw badRequest("INVALID_STREAK_MONTH", "Month must use YYYY-MM format."); }
  const now = new Date();
  const pref = await preference(userId);
  const todayKey = learnerDateKey(now, pref.timezone);
  const [days, user] = await Promise.all([
    prisma.learnerStreakDay.findMany({ where: { userId, localDate: { gte: bounds.start, lt: bounds.end } }, select: { localDate: true, status: true, focusSeconds: true, targetMinutes: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } }),
  ]);
  const byDate = new Map(days.map((day) => [databaseDateKey(day.localDate), day]));
  const joinedKey = learnerDateKey(user?.createdAt ?? now, pref.timezone);
  const cells = Array.from({ length: bounds.days }, (_, index) => {
    const date = databaseDateKey(new Date(bounds.start.getTime() + index * 86_400_000));
    const record = byDate.get(date);
    const status = record?.status === "PROTECTED" ? "protected" : record ? "active" : date > todayKey ? "future" : date === todayKey ? "today" : date >= joinedKey ? "missed" : "untracked";
    return { date, status, focusSeconds: record?.focusSeconds ?? 0, targetMinutes: record?.targetMinutes ?? null };
  });
  return { month, timezone: pref.timezone, cells, streak: await snapshot(userId, now) };
}

export async function getEligibleRecoveries(userId: string) {
  const now = new Date();
  const pref = await preference(userId);
  const todayKey = learnerDateKey(now, pref.timezone);
  const missedKey = addLearnerDays(todayKey, -1);
  const existing = await prisma.learnerStreakDay.findUnique({ where: { userId_localDate: { userId, localDate: databaseDate(missedKey) } }, select: { status: true } });
  if (existing) return { data: [], heartCost: 1, timezone: pref.timezone };
  const continuity = await prisma.learnerStreakDay.findFirst({ where: { userId, localDate: { lt: databaseDate(missedKey), gte: databaseDate(addLearnerDays(missedKey, -7)) } }, orderBy: { localDate: "desc" }, select: { localDate: true } });
  const today = await prisma.learnerStreakDay.findUnique({ where: { userId_localDate: { userId, localDate: databaseDate(todayKey) } }, select: { localDate: true } });
  return { data: continuity || today ? [{ date: missedKey, heartCost: 1, expiresAt: new Date(now.getTime() + 24 * 60 * 60_000) }] : [], heartCost: 1, timezone: pref.timezone };
}

export async function recoverStreakDay(userId: string, localDate: string, idempotencyKey: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || Number.isNaN(databaseDate(localDate).getTime())) throw badRequest("INVALID_RECOVERY_DATE", "Choose a valid missed date.");
  const existing = await prisma.learnerStreakDay.findUnique({ where: { userId_localDate: { userId, localDate: databaseDate(localDate) } }, select: { status: true } });
  if (existing?.status === "PROTECTED") return { recoveredDate: localDate, streak: await snapshot(userId) };
  if (existing) throw conflict("STREAK_DAY_ALREADY_ACTIVE", "This date already counts toward your streak.");
  await getRewardWallet(userId);
  const eligible = await getEligibleRecoveries(userId);
  if (!eligible.data.some((item) => item.date === localDate)) throw conflict("STREAK_RECOVERY_NOT_ELIGIBLE", "This missed date is not eligible for recovery.");
  const pref = await preference(userId);
  await prisma.$transaction(async (tx) => {
    const duplicate = await tx.learnerStreakDay.findUnique({ where: { userId_localDate: { userId, localDate: databaseDate(localDate) } } });
    if (duplicate) return;
    const ledger = await spendHeartInTransaction(tx, { userId, sourceId: localDate, idempotencyKey, policyVersion: RECOVERY_POLICY_VERSION });
    await tx.learnerStreakDay.create({ data: { userId, localDate: databaseDate(localDate), status: "PROTECTED", timezone: pref.timezone, focusSeconds: 0, targetMinutes: pref.dailyTargetMinutes, qualifiedAt: new Date(), protectedAt: new Date(), recoveryLedgerId: ledger.id } });
    await recalculateStreakState(tx, userId, pref.timezone);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return { recoveredDate: localDate, streak: await snapshot(userId) };
}
