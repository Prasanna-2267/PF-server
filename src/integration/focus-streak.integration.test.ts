import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { prisma } from "../db/prisma.js";
import * as focus from "../services/focusService.js";
import { addLearnerDays, databaseDate, learnerDateKey } from "../services/learnerTime.js";
import * as rewards from "../services/rewardService.js";
import * as streak from "../services/streakService.js";
import { integrationDatabaseEnabled } from "../tests/integration-database-guard.js";

const enabled = integrationDatabaseEnabled("RUN_BACKEND_INTEGRATION");
const suffix = randomUUID().slice(0, 8);
let userId = "";
let outsiderId = "";

before(async () => {
  if (!enabled) return;
  const role = await prisma.role.upsert({ where: { key: "student" }, create: { key: "student", name: "Student", description: "Learner role" }, update: {}, select: { id: true } });
  userId = randomUUID();
  outsiderId = randomUUID();
  await prisma.user.createMany({ data: [
    { id: userId, email: `focus-${suffix}@test.local`, fullName: "Focus Learner", roleId: role.id },
    { id: outsiderId, email: `focus-outsider-${suffix}@test.local`, fullName: "Other Learner", roleId: role.id },
  ] });
  await prisma.learnerPreference.create({ data: { userId, timezone: "UTC", dailyTargetMinutes: 15 } });
});

after(async () => {
  if (!enabled) return;
  await prisma.user.deleteMany({ where: { id: { in: [userId, outsiderId] } } });
  await prisma.$disconnect();
});

test("focus checkout is server-timed, replay-safe, and updates daily streak/rewards", { skip: !enabled }, async () => {
  const started = await focus.startFocusSession(userId, { source: "HOME", plannedDurationSeconds: 900 });
  const concurrent = await focus.startFocusSession(userId, { source: "TRACKER" });
  assert.equal(started.created, true);
  assert.equal(concurrent.created, false);
  assert.equal(concurrent.session.id, started.session.id);

  const backdatedStart = new Date(Date.now() - 16 * 60_000);
  await prisma.focusSession.update({ where: { id: started.session.id }, data: { startedAt: backdatedStart } });
  await assert.rejects(() => focus.heartbeatFocusSession(outsiderId, started.session.id), /not found/i);

  const completed = await focus.checkoutFocusSession(userId, started.session.id, `checkout-${suffix}`);
  assert.equal(completed.session.status, "COMPLETED");
  assert.ok((completed.session.durationSeconds ?? 0) >= 15 * 60);
  assert.equal(completed.dailyActivity?.goalCompleted, true);
  assert.equal(completed.dailyActivity?.focusSessionCount, 1);
  assert.equal(completed.rewardClaim?.points, 20);
  assert.equal(completed.streak.currentStreak, 1);

  const replay = await focus.checkoutFocusSession(userId, started.session.id, `checkout-${suffix}`);
  assert.equal(replay.dailyActivity?.focusSessionCount, 1);
  assert.equal(await prisma.rewardClaim.count({ where: { userId, sourceType: "DAILY_FOCUS" } }), 1);
  assert.equal((await focus.getActiveFocusSession(userId)).session, null);
  assert.equal((await focus.listFocusSessions(userId, { limit: 10 })).data.length, 1);

  await rewards.claimReward(userId, completed.rewardClaim!.id, `claim-focus-${suffix}`);
  const todayKey = learnerDateKey(new Date(), "UTC");
  const twoDaysAgo = addLearnerDays(todayKey, -2);
  await prisma.learnerStreakDay.create({ data: { userId, localDate: databaseDate(twoDaysAgo), timezone: "UTC", focusSeconds: 900, targetMinutes: 15, qualifiedAt: new Date() } });
  const eligible = await streak.getEligibleRecoveries(userId);
  assert.equal(eligible.data[0]?.date, addLearnerDays(todayKey, -1));
  const recovered = await streak.recoverStreakDay(userId, eligible.data[0]!.date, `recover-${suffix}`);
  assert.equal(recovered.streak.currentStreak, 3);
  assert.equal(recovered.streak.hearts, 2);
  const recoveredReplay = await streak.recoverStreakDay(userId, eligible.data[0]!.date, `recover-${suffix}`);
  assert.equal(recoveredReplay.streak.hearts, 2);

  const month = todayKey.slice(0, 7);
  const calendar = await streak.getStreakCalendar(userId, month);
  assert.equal(calendar.cells.find((cell) => cell.date === eligible.data[0]!.date)?.status, "protected");
});

test("abandon closes an accidental session without activity or rewards", { skip: !enabled }, async () => {
  const started = await focus.startFocusSession(userId, { source: "TRACKER" });
  const abandoned = await focus.abandonFocusSession(userId, started.session.id);
  assert.equal(abandoned.session.status, "ABANDONED");
  await assert.rejects(() => focus.checkoutFocusSession(userId, started.session.id, `abandoned-${suffix}`), /cannot be checked out/i);
});
