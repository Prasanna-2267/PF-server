-- Add direct Question Bank commerce without removing the nullable legacy
-- Package bridge. Existing records remain valid and can be migrated separately.
ALTER TYPE "LearningResourceType" ADD VALUE IF NOT EXISTS 'QUESTION_BANK';

ALTER TABLE "QuestionBank"
  ADD COLUMN IF NOT EXISTS "price" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS "accessDurationValue" INTEGER,
  ADD COLUMN IF NOT EXISTS "accessDurationUnit" "AccessDurationUnit";

-- Preserve already-created paid banks by snapshotting their legacy package
-- commercial policy before direct commerce takes over.
UPDATE "QuestionBank" qb
SET "price" = p."price",
    "accessDurationValue" = p."accessDurationValue",
    "accessDurationUnit" = p."accessDurationUnit"
FROM "Package" p
WHERE qb."packageId" = p."id" AND qb."accessType" = 'PAID';

ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "questionBankId" UUID;
ALTER TABLE "Entitlement" ADD COLUMN IF NOT EXISTS "questionBankId" UUID;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderItem_questionBankId_fkey' AND conrelid = '"OrderItem"'::regclass) THEN
    ALTER TABLE "OrderItem"
      ADD CONSTRAINT "OrderItem_questionBankId_fkey"
      FOREIGN KEY ("questionBankId") REFERENCES "QuestionBank"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Entitlement_questionBankId_fkey' AND conrelid = '"Entitlement"'::regclass) THEN
    ALTER TABLE "Entitlement"
      ADD CONSTRAINT "Entitlement_questionBankId_fkey"
      FOREIGN KEY ("questionBankId") REFERENCES "QuestionBank"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DROP INDEX IF EXISTS "Entitlement_user_question_bank_active_key";
CREATE UNIQUE INDEX "Entitlement_user_question_bank_active_key"
  ON "Entitlement" ("userId", "questionBankId")
  WHERE "status" = 'ACTIVE' AND "questionBankId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "OrderItem_questionBankId_idx" ON "OrderItem"("questionBankId");
CREATE INDEX IF NOT EXISTS "Entitlement_questionBankId_status_idx" ON "Entitlement"("questionBankId", "status");

ALTER TABLE "OrderItem" DROP CONSTRAINT IF EXISTS "OrderItem_resource_xor";
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_resource_xor" CHECK (
  (CASE WHEN "contentItemId" IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN "packageId" IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN "questionBankId" IS NOT NULL THEN 1 ELSE 0 END) = 1
);

ALTER TABLE "Entitlement" DROP CONSTRAINT IF EXISTS "Entitlement_resource_xor";
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_resource_xor" CHECK (
  (CASE WHEN "contentItemId" IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN "packageId" IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN "questionBankId" IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN "subjectId" IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN "courseId" IS NOT NULL THEN 1 ELSE 0 END) = 1
);

ALTER TABLE "QuestionBank" DROP CONSTRAINT IF EXISTS "QuestionBank_price_access_check";
ALTER TABLE "QuestionBank" ADD CONSTRAINT "QuestionBank_price_access_check" CHECK (
  ("accessType" = 'FREE' AND "price" = 0 AND "accessDurationValue" IS NULL AND "accessDurationUnit" IS NULL)
  OR
  ("accessType" = 'PAID' AND "price" > 0 AND
    (("accessDurationValue" IS NULL AND "accessDurationUnit" IS NULL)
     OR ("accessDurationValue" > 0 AND "accessDurationUnit" IS NOT NULL)))
);
