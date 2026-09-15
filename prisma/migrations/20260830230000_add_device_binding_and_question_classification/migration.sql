-- Production mobile device binding and question-classification snapshots.
-- Additive only: no existing data is removed or rewritten.

ALTER TABLE "UserSession"
  ADD COLUMN "deviceIdHash" VARCHAR(64),
  ADD COLUMN "deviceBindingVersion" INTEGER;

ALTER TABLE "RegistrationChallenge"
  ADD COLUMN "deviceIdHash" VARCHAR(64),
  ADD COLUMN "deviceSecretHash" VARCHAR(64),
  ADD COLUMN "deviceName" TEXT,
  ADD COLUMN "platform" "SessionPlatform" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "devicePolicyAcceptedAt" TIMESTAMP(3);

CREATE TABLE "StudentDeviceBinding" (
  "userId" UUID NOT NULL,
  "deviceIdHash" VARCHAR(64) NOT NULL,
  "deviceSecretHash" VARCHAR(64) NOT NULL,
  "deviceName" TEXT,
  "platform" "SessionPlatform" NOT NULL DEFAULT 'UNKNOWN',
  "bindingVersion" INTEGER NOT NULL DEFAULT 1,
  "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastVerifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resetApprovedAt" TIMESTAMP(3),
  "resetApprovedById" UUID,
  "resetConsumedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StudentDeviceBinding_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX "StudentDeviceBinding_deviceIdHash_idx" ON "StudentDeviceBinding"("deviceIdHash");
CREATE INDEX "StudentDeviceBinding_resetApprovedAt_resetConsumedAt_idx" ON "StudentDeviceBinding"("resetApprovedAt", "resetConsumedAt");

ALTER TABLE "StudentDeviceBinding"
  ADD CONSTRAINT "StudentDeviceBinding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "StudentDeviceBinding_resetApprovedById_fkey" FOREIGN KEY ("resetApprovedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Question"
  ADD COLUMN "examName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "chapterName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "conceptName" TEXT NOT NULL DEFAULT '';

ALTER TABLE "CaseSubQuestion"
  ADD COLUMN "examName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "chapterName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "conceptName" TEXT NOT NULL DEFAULT '';

ALTER TABLE "PracticeSessionQuestion"
  ADD COLUMN "examName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "chapterName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "conceptName" TEXT NOT NULL DEFAULT '';

ALTER TYPE "StudyPlanTaskType" ADD VALUE IF NOT EXISTS 'PRACTICE_WEAK_CONCEPT';
ALTER TYPE "StudyPlanTaskSource" ADD VALUE IF NOT EXISTS 'WEAK_CONCEPT';
