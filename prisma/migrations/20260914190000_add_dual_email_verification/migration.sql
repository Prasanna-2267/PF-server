ALTER TABLE "AccountVerificationChallenge"
  ADD COLUMN "previousValue" VARCHAR(320),
  ADD COLUMN "currentVerifiedAt" TIMESTAMP(3);
