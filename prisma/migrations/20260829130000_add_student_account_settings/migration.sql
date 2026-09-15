CREATE TYPE "LearnerTheme" AS ENUM ('LIGHT', 'DARK');
CREATE TYPE "AccountVerificationPurpose" AS ENUM ('EMAIL_CHANGE', 'MOBILE_CHANGE', 'DELETE_ACCOUNT');

ALTER TABLE "LearnerPreference"
ADD COLUMN "preferredTheme" "LearnerTheme" NOT NULL DEFAULT 'DARK';

CREATE TABLE "AccountVerificationChallenge" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "purpose" "AccountVerificationPurpose" NOT NULL,
  "targetValue" VARCHAR(320) NOT NULL,
  "otpHash" VARCHAR(64),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "resendCount" INTEGER NOT NULL DEFAULT 0,
  "sentAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccountVerificationChallenge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AccountVerificationChallenge_userId_purpose_consumedAt_cancelledAt_idx"
ON "AccountVerificationChallenge"("userId", "purpose", "consumedAt", "cancelledAt");

CREATE INDEX "AccountVerificationChallenge_expiresAt_idx"
ON "AccountVerificationChallenge"("expiresAt");

ALTER TABLE "AccountVerificationChallenge"
ADD CONSTRAINT "AccountVerificationChallenge_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
