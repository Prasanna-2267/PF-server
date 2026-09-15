-- A purchase and a manual admin grant are independent access sources. Keep
-- one active entitlement per resource and source while allowing both sources
-- to coexist for the same learner/resource pair.
DROP INDEX IF EXISTS "Entitlement_user_content_active_key";
CREATE UNIQUE INDEX "Entitlement_user_content_active_key"
  ON "Entitlement" ("userId", "contentItemId", "source")
  WHERE "status" = 'ACTIVE' AND "contentItemId" IS NOT NULL;

DROP INDEX IF EXISTS "Entitlement_user_package_active_key";
CREATE UNIQUE INDEX "Entitlement_user_package_active_key"
  ON "Entitlement" ("userId", "packageId", "source")
  WHERE "status" = 'ACTIVE' AND "packageId" IS NOT NULL;

DROP INDEX IF EXISTS "Entitlement_user_question_bank_active_key";
CREATE UNIQUE INDEX "Entitlement_user_question_bank_active_key"
  ON "Entitlement" ("userId", "questionBankId", "source")
  WHERE "status" = 'ACTIVE' AND "questionBankId" IS NOT NULL;
