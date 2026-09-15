CREATE TYPE "RewardClaimStatus" AS ENUM ('PENDING', 'CLAIMED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "RewardLedgerKind" AS ENUM ('EARN', 'SPEND', 'EXPIRE', 'ADJUST');
CREATE TYPE "RewardSourceType" AS ENUM ('DAILY_FOCUS', 'STREAK', 'HEART_RECOVERY', 'ADMIN_ADJUSTMENT');

CREATE TABLE "RewardWallet" (
    "userId" UUID NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "hearts" INTEGER NOT NULL DEFAULT 3,
    "heartPeriod" VARCHAR(7),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardWallet_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "RewardWallet_points_check" CHECK ("points" >= 0),
    CONSTRAINT "RewardWallet_hearts_check" CHECK ("hearts" BETWEEN 0 AND 3),
    CONSTRAINT "RewardWallet_version_check" CHECK ("version" > 0),
    CONSTRAINT "RewardWallet_heartPeriod_check" CHECK ("heartPeriod" IS NULL OR "heartPeriod" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);

CREATE TABLE "RewardClaim" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sourceType" "RewardSourceType" NOT NULL,
    "sourceId" VARCHAR(160) NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "hearts" INTEGER NOT NULL DEFAULT 0,
    "policyVersion" VARCHAR(80) NOT NULL,
    "status" "RewardClaimStatus" NOT NULL DEFAULT 'PENDING',
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardClaim_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RewardClaim_amount_check" CHECK ("points" >= 0 AND "hearts" >= 0 AND ("points" > 0 OR "hearts" > 0)),
    CONSTRAINT "RewardClaim_sourceId_check" CHECK (LENGTH(BTRIM("sourceId")) > 0),
    CONSTRAINT "RewardClaim_policyVersion_check" CHECK (LENGTH(BTRIM("policyVersion")) > 0),
    CONSTRAINT "RewardClaim_expiry_check" CHECK ("expiresAt" IS NULL OR "expiresAt" > "availableAt"),
    CONSTRAINT "RewardClaim_claimed_check" CHECK (("status" = 'CLAIMED' AND "claimedAt" IS NOT NULL) OR ("status" <> 'CLAIMED' AND "claimedAt" IS NULL))
);

CREATE TABLE "RewardLedgerEntry" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "RewardLedgerKind" NOT NULL,
    "sourceType" "RewardSourceType" NOT NULL,
    "sourceId" VARCHAR(160) NOT NULL,
    "pointsDelta" INTEGER NOT NULL DEFAULT 0,
    "heartsDelta" INTEGER NOT NULL DEFAULT 0,
    "pointsBalanceAfter" INTEGER NOT NULL,
    "heartsBalanceAfter" INTEGER NOT NULL,
    "policyVersion" VARCHAR(80) NOT NULL,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "claimId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardLedgerEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RewardLedgerEntry_delta_check" CHECK ("pointsDelta" <> 0 OR "heartsDelta" <> 0),
    CONSTRAINT "RewardLedgerEntry_balance_check" CHECK ("pointsBalanceAfter" >= 0 AND "heartsBalanceAfter" BETWEEN 0 AND 3),
    CONSTRAINT "RewardLedgerEntry_sourceId_check" CHECK (LENGTH(BTRIM("sourceId")) > 0),
    CONSTRAINT "RewardLedgerEntry_policyVersion_check" CHECK (LENGTH(BTRIM("policyVersion")) > 0),
    CONSTRAINT "RewardLedgerEntry_idempotencyKey_check" CHECK (LENGTH(BTRIM("idempotencyKey")) > 0)
);

CREATE INDEX "RewardWallet_updatedAt_idx" ON "RewardWallet"("updatedAt");
CREATE UNIQUE INDEX "RewardClaim_userId_sourceType_sourceId_policyVersion_key" ON "RewardClaim"("userId", "sourceType", "sourceId", "policyVersion");
CREATE INDEX "RewardClaim_userId_status_availableAt_idx" ON "RewardClaim"("userId", "status", "availableAt");
CREATE INDEX "RewardClaim_expiresAt_status_idx" ON "RewardClaim"("expiresAt", "status");
CREATE UNIQUE INDEX "RewardLedgerEntry_userId_idempotencyKey_key" ON "RewardLedgerEntry"("userId", "idempotencyKey");
CREATE UNIQUE INDEX "RewardLedgerEntry_claimId_key" ON "RewardLedgerEntry"("claimId");
CREATE INDEX "RewardLedgerEntry_userId_createdAt_id_idx" ON "RewardLedgerEntry"("userId", "createdAt", "id");
CREATE INDEX "RewardLedgerEntry_sourceType_sourceId_idx" ON "RewardLedgerEntry"("sourceType", "sourceId");

ALTER TABLE "RewardWallet" ADD CONSTRAINT "RewardWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RewardClaim" ADD CONSTRAINT "RewardClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RewardLedgerEntry" ADD CONSTRAINT "RewardLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RewardLedgerEntry" ADD CONSTRAINT "RewardLedgerEntry_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "RewardClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;
