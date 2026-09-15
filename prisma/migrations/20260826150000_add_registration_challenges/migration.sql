CREATE TABLE "RegistrationChallenge" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "passwordHash" TEXT,
    "emailOtpHash" VARCHAR(64),
    "mobileOtpHash" VARCHAR(64),
    "emailAttempts" INTEGER NOT NULL DEFAULT 0,
    "mobileAttempts" INTEGER NOT NULL DEFAULT 0,
    "emailResendCount" INTEGER NOT NULL DEFAULT 0,
    "mobileResendCount" INTEGER NOT NULL DEFAULT 0,
    "emailSentAt" TIMESTAMP(3),
    "mobileSentAt" TIMESTAMP(3),
    "emailVerifiedAt" TIMESTAMP(3),
    "mobileVerifiedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistrationChallenge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RegistrationChallenge_email_completedAt_cancelledAt_idx"
ON "RegistrationChallenge"("email", "completedAt", "cancelledAt");

CREATE INDEX "RegistrationChallenge_expiresAt_idx"
ON "RegistrationChallenge"("expiresAt");
