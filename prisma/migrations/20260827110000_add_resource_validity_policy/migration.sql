CREATE TYPE "ContentValidityMode" AS ENUM ('PERMANENT', 'EXAM_DATE_OFFSET');

ALTER TABLE "ContentItem"
  ADD COLUMN "validityMode" "ContentValidityMode" NOT NULL DEFAULT 'PERMANENT',
  ADD COLUMN "validityOffsetDays" INTEGER;

ALTER TABLE "ContentItem"
  ADD CONSTRAINT "ContentItem_validity_policy_check"
  CHECK (
    ("validityMode" = 'PERMANENT' AND "validityOffsetDays" IS NULL)
    OR
    (
      "accessType" = 'PAID'
      AND "validityMode" = 'EXAM_DATE_OFFSET'
      AND "validityOffsetDays" BETWEEN 0 AND 3650
    )
  );
