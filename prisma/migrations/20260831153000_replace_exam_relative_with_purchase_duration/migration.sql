-- Add the new purchase-relative commercial policy without dropping the old
-- exam-relative columns. Keeping the legacy columns is intentionally
-- backwards-compatible with the other Admin client while all current APIs
-- move to the new policy.
CREATE TYPE "AccessDurationUnit" AS ENUM ('DAYS', 'WEEKS', 'MONTHS');

ALTER TABLE "ContentItem"
  ADD COLUMN "accessDurationValue" INTEGER,
  ADD COLUMN "accessDurationUnit" "AccessDurationUnit";

ALTER TABLE "Package"
  ADD COLUMN "accessDurationValue" INTEGER,
  ADD COLUMN "accessDurationUnit" "AccessDurationUnit";

ALTER TABLE "Entitlement"
  ADD COLUMN "purchasedAt" TIMESTAMP(3),
  ADD COLUMN "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Preserve a useful fixed-duration rule for future sales of legacy resources,
-- but do not alter any already-issued entitlement or its expiry.
UPDATE "ContentItem"
SET "accessDurationValue" = GREATEST("validityOffsetDays", 1),
    "accessDurationUnit" = 'DAYS'
WHERE "accessType" = 'PAID'
  AND "validityMode" = 'EXAM_DATE_OFFSET'
  AND "validityOffsetDays" IS NOT NULL;

UPDATE "Entitlement"
SET "startsAt" = "grantedAt";

UPDATE "Entitlement" e
SET "purchasedAt" = CASE
      WHEN e."source" = 'PURCHASE' THEN COALESCE(o."paidAt", e."grantedAt")
      ELSE NULL
    END
FROM "Order" o
WHERE e."orderId" = o."id";

ALTER TABLE "ContentItem" ADD CONSTRAINT "ContentItem_access_duration_pair"
CHECK (
  ("accessDurationValue" IS NULL AND "accessDurationUnit" IS NULL)
  OR (
    "accessDurationValue" IS NOT NULL
    AND "accessDurationUnit" IS NOT NULL
    AND "accessDurationValue" > 0
    AND (
      ("accessDurationUnit" = 'DAYS' AND "accessDurationValue" <= 3650)
      OR ("accessDurationUnit" = 'WEEKS' AND "accessDurationValue" <= 520)
      OR ("accessDurationUnit" = 'MONTHS' AND "accessDurationValue" <= 120)
    )
  )
);

ALTER TABLE "Package" ADD CONSTRAINT "Package_access_duration_pair"
CHECK (
  ("accessDurationValue" IS NULL AND "accessDurationUnit" IS NULL)
  OR (
    "accessDurationValue" IS NOT NULL
    AND "accessDurationUnit" IS NOT NULL
    AND "accessDurationValue" > 0
    AND (
      ("accessDurationUnit" = 'DAYS' AND "accessDurationValue" <= 3650)
      OR ("accessDurationUnit" = 'WEEKS' AND "accessDurationValue" <= 520)
      OR ("accessDurationUnit" = 'MONTHS' AND "accessDurationValue" <= 120)
    )
  )
);
