CREATE TYPE "FocusSessionSource" AS ENUM ('HOME', 'TRACKER', 'STUDY_TASK', 'NOTE');
CREATE TYPE "FocusSessionStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'ABANDONED');
CREATE TYPE "StreakDayStatus" AS ENUM ('ACTIVE', 'PROTECTED');

CREATE TABLE "FocusSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "source" "FocusSessionSource" NOT NULL,
    "sourceId" UUID,
    "plannedDurationSeconds" INTEGER,
    "status" "FocusSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedOutAt" TIMESTAMP(3),
    "abandonedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "checkoutIdempotencyKey" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FocusSession_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FocusSession_plannedDurationSeconds_check" CHECK ("plannedDurationSeconds" IS NULL OR "plannedDurationSeconds" BETWEEN 60 AND 86400),
    CONSTRAINT "FocusSession_durationSeconds_check" CHECK ("durationSeconds" IS NULL OR "durationSeconds" >= 0),
    CONSTRAINT "FocusSession_heartbeat_check" CHECK ("lastHeartbeatAt" >= "startedAt"),
    CONSTRAINT "FocusSession_lifecycle_check" CHECK (
      ("status" = 'ACTIVE' AND "checkedOutAt" IS NULL AND "abandonedAt" IS NULL AND "durationSeconds" IS NULL AND "checkoutIdempotencyKey" IS NULL) OR
      ("status" = 'COMPLETED' AND "checkedOutAt" IS NOT NULL AND "abandonedAt" IS NULL AND "durationSeconds" IS NOT NULL AND "checkoutIdempotencyKey" IS NOT NULL) OR
      ("status" = 'ABANDONED' AND "checkedOutAt" IS NULL AND "abandonedAt" IS NOT NULL AND "durationSeconds" IS NULL AND "checkoutIdempotencyKey" IS NULL)
    )
);

CREATE TABLE "LearnerDailyActivity" (
    "userId" UUID NOT NULL,
    "localDate" DATE NOT NULL,
    "timezone" VARCHAR(80) NOT NULL,
    "targetMinutes" INTEGER NOT NULL,
    "focusSeconds" INTEGER NOT NULL DEFAULT 0,
    "readingSeconds" INTEGER NOT NULL DEFAULT 0,
    "practiceSeconds" INTEGER NOT NULL DEFAULT 0,
    "revisionSeconds" INTEGER NOT NULL DEFAULT 0,
    "focusSessionCount" INTEGER NOT NULL DEFAULT 0,
    "qualifiesStreak" BOOLEAN NOT NULL DEFAULT false,
    "goalCompleted" BOOLEAN NOT NULL DEFAULT false,
    "lastActivityAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearnerDailyActivity_pkey" PRIMARY KEY ("userId", "localDate"),
    CONSTRAINT "LearnerDailyActivity_targetMinutes_check" CHECK ("targetMinutes" BETWEEN 15 AND 720),
    CONSTRAINT "LearnerDailyActivity_seconds_check" CHECK ("focusSeconds" >= 0 AND "readingSeconds" >= 0 AND "practiceSeconds" >= 0 AND "revisionSeconds" >= 0),
    CONSTRAINT "LearnerDailyActivity_sessionCount_check" CHECK ("focusSessionCount" >= 0)
);

CREATE TABLE "LearnerStreakState" (
    "userId" UUID NOT NULL,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastQualifiedDate" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearnerStreakState_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "LearnerStreakState_counts_check" CHECK ("currentStreak" >= 0 AND "longestStreak" >= "currentStreak"),
    CONSTRAINT "LearnerStreakState_version_check" CHECK ("version" > 0)
);

CREATE TABLE "LearnerStreakDay" (
    "userId" UUID NOT NULL,
    "localDate" DATE NOT NULL,
    "status" "StreakDayStatus" NOT NULL DEFAULT 'ACTIVE',
    "timezone" VARCHAR(80) NOT NULL,
    "focusSeconds" INTEGER NOT NULL DEFAULT 0,
    "targetMinutes" INTEGER NOT NULL,
    "qualifiedAt" TIMESTAMP(3) NOT NULL,
    "protectedAt" TIMESTAMP(3),
    "recoveryLedgerId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearnerStreakDay_pkey" PRIMARY KEY ("userId", "localDate"),
    CONSTRAINT "LearnerStreakDay_focusSeconds_check" CHECK ("focusSeconds" >= 0),
    CONSTRAINT "LearnerStreakDay_targetMinutes_check" CHECK ("targetMinutes" BETWEEN 15 AND 720),
    CONSTRAINT "LearnerStreakDay_status_check" CHECK (("status" = 'ACTIVE' AND "protectedAt" IS NULL AND "recoveryLedgerId" IS NULL) OR ("status" = 'PROTECTED' AND "protectedAt" IS NOT NULL AND "recoveryLedgerId" IS NOT NULL))
);

CREATE UNIQUE INDEX "FocusSession_userId_checkoutIdempotencyKey_key" ON "FocusSession"("userId", "checkoutIdempotencyKey");
CREATE UNIQUE INDEX "FocusSession_one_active_per_user_key" ON "FocusSession"("userId") WHERE "status" = 'ACTIVE';
CREATE INDEX "FocusSession_userId_status_startedAt_idx" ON "FocusSession"("userId", "status", "startedAt");
CREATE INDEX "FocusSession_userId_startedAt_id_idx" ON "FocusSession"("userId", "startedAt", "id");
CREATE INDEX "FocusSession_lastHeartbeatAt_status_idx" ON "FocusSession"("lastHeartbeatAt", "status");
CREATE INDEX "LearnerDailyActivity_userId_localDate_idx" ON "LearnerDailyActivity"("userId", "localDate");
CREATE INDEX "LearnerDailyActivity_localDate_qualifiesStreak_idx" ON "LearnerDailyActivity"("localDate", "qualifiesStreak");
CREATE INDEX "LearnerStreakDay_userId_status_localDate_idx" ON "LearnerStreakDay"("userId", "status", "localDate");
CREATE UNIQUE INDEX "LearnerStreakDay_recoveryLedgerId_key" ON "LearnerStreakDay"("recoveryLedgerId");

ALTER TABLE "FocusSession" ADD CONSTRAINT "FocusSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearnerDailyActivity" ADD CONSTRAINT "LearnerDailyActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearnerStreakState" ADD CONSTRAINT "LearnerStreakState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearnerStreakDay" ADD CONSTRAINT "LearnerStreakDay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearnerStreakDay" ADD CONSTRAINT "LearnerStreakDay_recoveryLedgerId_fkey" FOREIGN KEY ("recoveryLedgerId") REFERENCES "RewardLedgerEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
