-- A package may include any number of existing Question Banks without
-- changing the Question Bank's identity or direct-purchase entitlement.
CREATE TABLE "PackageQuestionBank" (
    "id" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "questionBankId" UUID NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PackageQuestionBank_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PackageQuestionBank_packageId_questionBankId_key"
ON "PackageQuestionBank"("packageId", "questionBankId");

CREATE INDEX "PackageQuestionBank_packageId_displayOrder_idx"
ON "PackageQuestionBank"("packageId", "displayOrder");

CREATE INDEX "PackageQuestionBank_questionBankId_idx"
ON "PackageQuestionBank"("questionBankId");

ALTER TABLE "PackageQuestionBank"
ADD CONSTRAINT "PackageQuestionBank_packageId_fkey"
FOREIGN KEY ("packageId") REFERENCES "Package"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PackageQuestionBank"
ADD CONSTRAINT "PackageQuestionBank_questionBankId_fkey"
FOREIGN KEY ("questionBankId") REFERENCES "QuestionBank"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Preserve membership represented by the legacy one-bank/one-package bridge.
INSERT INTO "PackageQuestionBank" ("id", "packageId", "questionBankId", "displayOrder", "addedAt")
SELECT gen_random_uuid(), "packageId", "id", 0, CURRENT_TIMESTAMP
FROM "QuestionBank"
WHERE "packageId" IS NOT NULL
ON CONFLICT ("packageId", "questionBankId") DO NOTHING;
