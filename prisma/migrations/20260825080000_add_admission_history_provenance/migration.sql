ALTER TABLE "AdmissionRecord"
  ADD COLUMN "createdById" UUID,
  ADD COLUMN "completedAt" TIMESTAMP(3);

UPDATE "AdmissionRecord"
SET "completedAt" = "createdAt"
WHERE "completedAt" IS NULL;

CREATE INDEX "AdmissionRecord_createdById_idx" ON "AdmissionRecord"("createdById");

ALTER TABLE "AdmissionRecord"
  ADD CONSTRAINT "AdmissionRecord_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
