import { Prisma, type RewardSourceType } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { badRequest, conflict, notFound } from "../errors/api-error.js";
import { learnerDateKey } from "./learnerTime.js";

const HEART_CAP = 3;
const DAILY_FOCUS_POLICY_VERSION = "daily-focus-v1";

type RewardClaimInput = {
  userId: string;
  sourceType: RewardSourceType;
  sourceId: string;
  points?: number;
  hearts?: number;
  policyVersion: string;
  availableAt?: Date;
  expiresAt?: Date | null;
};

function validateServerClaim(input: RewardClaimInput) {
  const sourceId = input.sourceId.trim();
  const policyVersion = input.policyVersion.trim();
  const points = input.points ?? 0;
  const hearts = input.hearts ?? 0;
  if (!sourceId || sourceId.length > 160) throw new Error("A reward source ID between 1 and 160 characters is required.");
  if (!policyVersion || policyVersion.length > 80) throw new Error("A reward policy version between 1 and 80 characters is required.");
  if (!Number.isInteger(points) || points < 0 || points > 1_000_000 || !Number.isInteger(hearts) || hearts < 0 || hearts > HEART_CAP || points + hearts === 0) throw new Error("A reward claim must contain a bounded positive integer points or hearts amount.");
  if (input.expiresAt && input.availableAt && input.expiresAt <= input.availableAt) throw new Error("A reward claim must expire after it becomes available.");
  return { sourceId, policyVersion, points, hearts };
}

/**
 * Server-side feature services use this function to mint a claim after validating
 * their own source event. It is deliberately not exposed as a student route.
 */
export async function createRewardClaim(input: RewardClaimInput, database: Prisma.TransactionClient | typeof prisma = prisma) {
  const normalized = validateServerClaim(input);
  return database.rewardClaim.upsert({
    where: {
      userId_sourceType_sourceId_policyVersion: {
        userId: input.userId,
        sourceType: input.sourceType,
        sourceId: normalized.sourceId,
        policyVersion: normalized.policyVersion,
      },
    },
    create: {
      userId: input.userId,
      sourceType: input.sourceType,
      sourceId: normalized.sourceId,
      points: normalized.points,
      hearts: normalized.hearts,
      policyVersion: normalized.policyVersion,
      availableAt: input.availableAt,
      expiresAt: input.expiresAt,
    },
    update: {},
  });
}

function nextUtcMonth(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export async function getRewardWallet(userId: string) {
  const now = new Date();
  const preference = await prisma.learnerPreference.findUnique({ where: { userId }, select: { timezone: true } });
  const heartPeriod = learnerDateKey(now, preference?.timezone ?? "Asia/Kolkata").slice(0, 7);
  let wallet = await prisma.rewardWallet.upsert({ where: { userId }, create: { userId, hearts: HEART_CAP, heartPeriod }, update: {}, select: { points: true, hearts: true, heartPeriod: true, version: true, updatedAt: true } });
  if (wallet.heartPeriod !== heartPeriod) wallet = await prisma.rewardWallet.update({ where: { userId }, data: { hearts: HEART_CAP, heartPeriod, version: { increment: 1 } }, select: { points: true, hearts: true, heartPeriod: true, version: true, updatedAt: true } });
  const pendingClaims = await prisma.rewardClaim.count({ where: { userId, status: "PENDING", availableAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } });
  return {
    points: wallet.points,
    hearts: wallet.hearts,
    heartCap: HEART_CAP,
    pendingClaims,
    version: wallet.version,
    updatedAt: wallet.updatedAt,
    heartRefreshAt: nextUtcMonth(now),
    serverTime: now,
  };
}

export async function listRewardLedger(userId: string, input: { cursor?: string; limit: number }) {
  const cursor = input.cursor
    ? await prisma.rewardLedgerEntry.findFirst({ where: { id: input.cursor, userId }, select: { id: true, createdAt: true } })
    : null;
  if (input.cursor && !cursor) throw badRequest("INVALID_REWARD_CURSOR", "The reward history cursor is invalid.");
  const data = await prisma.rewardLedgerEntry.findMany({
    where: {
      userId,
      ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    select: { id: true, kind: true, sourceType: true, sourceId: true, pointsDelta: true, heartsDelta: true, pointsBalanceAfter: true, heartsBalanceAfter: true, policyVersion: true, createdAt: true },
  });
  const hasMore = data.length > input.limit;
  const page = hasMore ? data.slice(0, input.limit) : data;
  return { data: page, nextCursor: hasMore ? page.at(-1)!.id : null };
}

export function getRewardRules() {
  return {
    policyVersion: DAILY_FOCUS_POLICY_VERSION,
    dailyFocus: {
      belowTargetPoints: 10,
      targetMetPoints: 20,
      maximumAwardsPerLearnerDay: 1,
    },
    hearts: { walletCap: HEART_CAP, recoveryCost: 1 },
  };
}

export async function spendHeartInTransaction(tx: Prisma.TransactionClient, input: { userId: string; sourceId: string; idempotencyKey: string; policyVersion: string }) {
  const existing = await tx.rewardLedgerEntry.findUnique({
    where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey } },
  });
  if (existing) {
    if (existing.sourceType !== "HEART_RECOVERY" || existing.sourceId !== input.sourceId) throw conflict("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for another reward operation.");
    return existing;
  }
  const wallet = await tx.rewardWallet.findUnique({ where: { userId: input.userId } });
  if (!wallet || wallet.hearts < 1) throw conflict("HEART_BALANCE_INSUFFICIENT", "No recovery hearts are available.");
  const updated = await tx.rewardWallet.update({ where: { userId: input.userId }, data: { hearts: { decrement: 1 }, version: { increment: 1 } } });
  return tx.rewardLedgerEntry.create({
    data: {
      userId: input.userId,
      kind: "SPEND",
      sourceType: "HEART_RECOVERY",
      sourceId: input.sourceId,
      pointsDelta: 0,
      heartsDelta: -1,
      pointsBalanceAfter: updated.points,
      heartsBalanceAfter: updated.hearts,
      policyVersion: input.policyVersion,
      idempotencyKey: input.idempotencyKey,
    },
  });
}

async function claimedResponse(userId: string, claimId: string) {
  const claim = await prisma.rewardClaim.findFirst({
    where: { id: claimId, userId, status: "CLAIMED" },
    select: { id: true, status: true, claimedAt: true, ledgerEntry: { select: { id: true, pointsDelta: true, heartsDelta: true, pointsBalanceAfter: true, heartsBalanceAfter: true, createdAt: true } } },
  });
  return claim ? { claim, wallet: await getRewardWallet(userId) } : null;
}

async function claimOnce(userId: string, claimId: string, idempotencyKey: string) {
  const priorEntry = await prisma.rewardLedgerEntry.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } }, select: { claim: { select: { id: true } } } });
  if (priorEntry) {
    if (priorEntry.claim?.id !== claimId) throw conflict("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for another reward claim.");
    return claimedResponse(userId, claimId);
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const claim = await tx.rewardClaim.findFirst({ where: { id: claimId, userId } });
    if (!claim) throw notFound("REWARD_CLAIM_NOT_FOUND", "The reward claim was not found.");
    if (claim.status === "CLAIMED") return;
    if (claim.status !== "PENDING") throw conflict("REWARD_CLAIM_UNAVAILABLE", "This reward claim is no longer available.");
    if (claim.availableAt > now) throw conflict("REWARD_CLAIM_NOT_READY", "This reward is not ready to be claimed.");
    if (claim.expiresAt && claim.expiresAt <= now) throw conflict("REWARD_CLAIM_EXPIRED", "This reward claim has expired.");

    const current = await tx.rewardWallet.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: { points: true, hearts: true },
    });
    const awardedHearts = Math.min(claim.hearts, Math.max(0, HEART_CAP - current.hearts));
    if (claim.points === 0 && claim.hearts > 0 && awardedHearts === 0) throw conflict("HEART_WALLET_FULL", "Your heart wallet is already full.");
    const pointsAfter = current.points + claim.points;
    const heartsAfter = current.hearts + awardedHearts;
    const wallet = await tx.rewardWallet.update({ where: { userId }, data: { points: pointsAfter, hearts: heartsAfter, version: { increment: 1 } } });
    await tx.rewardLedgerEntry.create({
      data: {
        userId,
        kind: "EARN",
        sourceType: claim.sourceType,
        sourceId: claim.sourceId,
        pointsDelta: claim.points,
        heartsDelta: awardedHearts,
        pointsBalanceAfter: wallet.points,
        heartsBalanceAfter: wallet.hearts,
        policyVersion: claim.policyVersion,
        idempotencyKey,
        claimId: claim.id,
      },
    });
    const finalized = await tx.rewardClaim.updateMany({
      where: { id: claim.id, userId, status: "PENDING" },
      data: { status: "CLAIMED", claimedAt: now },
    });
    if (finalized.count !== 1) throw conflict("REWARD_CLAIM_CONFLICT", "This reward is already being claimed.");
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  return claimedResponse(userId, claimId);
}

export async function claimReward(userId: string, claimId: string, idempotencyKey: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await claimOnce(userId, claimId, idempotencyKey);
      if (result) return result;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034") && attempt < 2) continue;
      throw error;
    }
  }
  const winner = await claimedResponse(userId, claimId);
  if (winner) return winner;
  throw conflict("REWARD_CLAIM_CONFLICT", "The reward could not be claimed safely. Please retry.");
}
