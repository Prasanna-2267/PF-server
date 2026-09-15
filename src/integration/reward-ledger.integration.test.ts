import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { prisma } from "../db/prisma.js";
import * as rewards from "../services/rewardService.js";
import { integrationDatabaseEnabled } from "../tests/integration-database-guard.js";

const enabled = integrationDatabaseEnabled("RUN_BACKEND_INTEGRATION");
const suffix = randomUUID().slice(0, 8);
let userId = "";

before(async () => {
  if (!enabled) return;
  const role = await prisma.role.upsert({
    where: { key: "student" },
    create: { key: "student", name: "Student", description: "Learner role" },
    update: {},
    select: { id: true },
  });
  userId = randomUUID();
  await prisma.user.create({ data: { id: userId, email: `reward-${suffix}@test.local`, fullName: "Reward Test Learner", roleId: role.id } });
});

after(async () => {
  if (!enabled || !userId) return;
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

test("reward claims are server-minted, capped, immutable, and idempotent", { skip: !enabled }, async () => {
  const empty = await rewards.getRewardWallet(userId);
  assert.equal(empty.points, 0);
  assert.equal(empty.hearts, 3);
  assert.equal(empty.pendingClaims, 0);

  const pointsClaim = await rewards.createRewardClaim({
    userId,
    sourceType: "DAILY_FOCUS",
    sourceId: "2026-08-26",
    points: 20,
    policyVersion: "daily-focus-v1",
  });
  const duplicateSource = await rewards.createRewardClaim({
    userId,
    sourceType: "DAILY_FOCUS",
    sourceId: "2026-08-26",
    points: 20,
    policyVersion: "daily-focus-v1",
  });
  assert.equal(duplicateSource.id, pointsClaim.id);

  const first = await rewards.claimReward(userId, pointsClaim.id, `reward-${suffix}-points`);
  const replay = await rewards.claimReward(userId, pointsClaim.id, `reward-${suffix}-points`);
  assert.equal(first.claim.ledgerEntry?.id, replay.claim.ledgerEntry?.id);
  assert.equal(replay.wallet.points, 20);

  await prisma.rewardWallet.update({ where: { userId }, data: { hearts: 2 } });
  const heartClaim = await rewards.createRewardClaim({
    userId,
    sourceType: "STREAK",
    sourceId: "monthly-heart-demo",
    hearts: 3,
    policyVersion: "heart-cap-v1",
  });
  await assert.rejects(
    () => rewards.claimReward(userId, heartClaim.id, `reward-${suffix}-points`),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "IDEMPOTENCY_KEY_REUSED"),
  );
  const capped = await rewards.claimReward(userId, heartClaim.id, `reward-${suffix}-hearts`);
  assert.equal(capped.wallet.hearts, 3);

  const wallet = await rewards.getRewardWallet(userId);
  assert.equal(wallet.points, 20);
  assert.equal(wallet.hearts, 3);
  assert.equal(wallet.pendingClaims, 0);

  const ledger = await rewards.listRewardLedger(userId, { limit: 1 });
  assert.equal(ledger.data.length, 1);
  assert.ok(ledger.nextCursor);
  const secondPage = await rewards.listRewardLedger(userId, { cursor: ledger.nextCursor!, limit: 10 });
  assert.equal(secondPage.data.length, 1);
  assert.equal(secondPage.nextCursor, null);
  assert.equal(await prisma.rewardLedgerEntry.count({ where: { userId } }), 2);
});
