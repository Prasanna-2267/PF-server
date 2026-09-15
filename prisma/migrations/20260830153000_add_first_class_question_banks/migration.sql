-- First-class Question Bank containers. This migration is additive and
-- preserves the existing Package/Content/Entitlement access model.
CREATE TABLE "QuestionBank" (
    "id" UUID NOT NULL,
    "academyId" UUID,
    "courseId" UUID NOT NULL,
    "packageId" UUID,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "accessType" "ContentAccessType" NOT NULL DEFAULT 'FREE',
    "questionKind" "QuestionKind" NOT NULL DEFAULT 'NORMAL_MCQ',
    "status" "PackageStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "QuestionBank_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QuestionBankQuestion" (
    "questionBankId" UUID NOT NULL,
    "questionId" UUID NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionBankQuestion_pkey" PRIMARY KEY ("questionBankId", "questionId")
);

ALTER TABLE "PracticeSession" ADD COLUMN "questionBankId" UUID;

CREATE UNIQUE INDEX "QuestionBank_packageId_key" ON "QuestionBank"("packageId");
CREATE UNIQUE INDEX "QuestionBank_courseId_slug_key" ON "QuestionBank"("courseId", "slug");
CREATE INDEX "QuestionBank_academyId_status_deletedAt_idx" ON "QuestionBank"("academyId", "status", "deletedAt");
CREATE INDEX "QuestionBank_courseId_accessType_status_deletedAt_idx" ON "QuestionBank"("courseId", "accessType", "status", "deletedAt");
CREATE INDEX "QuestionBankQuestion_questionId_questionBankId_idx" ON "QuestionBankQuestion"("questionId", "questionBankId");
CREATE INDEX "QuestionBankQuestion_questionBankId_displayOrder_idx" ON "QuestionBankQuestion"("questionBankId", "displayOrder");
CREATE INDEX "PracticeSession_questionBankId_status_startedAt_idx" ON "PracticeSession"("questionBankId", "status", "startedAt");

ALTER TABLE "QuestionBank" ADD CONSTRAINT "QuestionBank_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "QuestionBank" ADD CONSTRAINT "QuestionBank_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuestionBank" ADD CONSTRAINT "QuestionBank_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "QuestionBankQuestion" ADD CONSTRAINT "QuestionBankQuestion_questionBankId_fkey" FOREIGN KEY ("questionBankId") REFERENCES "QuestionBank"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionBankQuestion" ADD CONSTRAINT "QuestionBankQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PracticeSession" ADD CONSTRAINT "PracticeSession_questionBankId_fkey" FOREIGN KEY ("questionBankId") REFERENCES "QuestionBank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Preserve existing package-backed Question Bank data by materialising one
-- bank per package whose files currently have Question Bank questions.
WITH RECURSIVE package_content AS (
    SELECT pi."packageId", pi."contentItemId"
    FROM "PackageItem" pi
    UNION ALL
    SELECT pc."packageId", child."id"
    FROM package_content pc
    JOIN "ContentItem" child ON child."parentId" = pc."contentItemId"
    WHERE child."deletedAt" IS NULL
), candidate_packages AS (
    SELECT DISTINCT p."id", p."courseId", c."academyId", p."title", p."slug", p."description", p."price", p."status", p."createdAt", p."updatedAt", p."deletedAt"
    FROM "Package" p
    JOIN "Course" c ON c."id" = p."courseId"
    JOIN package_content pc ON pc."packageId" = p."id"
    JOIN "QuestionContentLink" qcl ON qcl."contentItemId" = pc."contentItemId"
    JOIN "Question" q ON q."id" = qcl."questionId"
    WHERE q."practiceCollection" = 'QUESTION_BANK' AND q."deletedAt" IS NULL
)
INSERT INTO "QuestionBank" ("id", "academyId", "courseId", "packageId", "name", "slug", "description", "accessType", "status", "createdAt", "updatedAt", "deletedAt")
SELECT gen_random_uuid(), cp."academyId", cp."courseId", cp."id", cp."title", cp."slug" || '-qb-' || substr(cp."id"::text, 1, 8), cp."description",
       CASE WHEN cp."price" > 0 THEN 'PAID'::"ContentAccessType" ELSE 'FREE'::"ContentAccessType" END,
       cp."status", cp."createdAt", cp."updatedAt", cp."deletedAt"
FROM candidate_packages cp
ON CONFLICT ("packageId") DO NOTHING;

WITH RECURSIVE package_content AS (
    SELECT pi."packageId", pi."contentItemId"
    FROM "PackageItem" pi
    UNION ALL
    SELECT pc."packageId", child."id"
    FROM package_content pc
    JOIN "ContentItem" child ON child."parentId" = pc."contentItemId"
    WHERE child."deletedAt" IS NULL
)
INSERT INTO "QuestionBankQuestion" ("questionBankId", "questionId", "displayOrder")
SELECT DISTINCT qb."id", q."id", 0
FROM "QuestionBank" qb
JOIN package_content pc ON pc."packageId" = qb."packageId"
JOIN "QuestionContentLink" qcl ON qcl."contentItemId" = pc."contentItemId"
JOIN "Question" q ON q."id" = qcl."questionId"
WHERE q."practiceCollection" = 'QUESTION_BANK' AND q."deletedAt" IS NULL
ON CONFLICT ("questionBankId", "questionId") DO NOTHING;

-- Legacy free Question Bank questions that were not part of a package are
-- grouped into one non-commercial bank per course so no existing question is
-- lost during the transition.
INSERT INTO "QuestionBank" ("id", "academyId", "courseId", "name", "slug", "description", "accessType", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c."academyId", c."id", c."name" || ' Question Bank', 'legacy-free-question-bank',
       'Migrated free Question Bank questions.', 'FREE'::"ContentAccessType", 'PUBLISHED'::"PackageStatus", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Course" c
WHERE EXISTS (
    SELECT 1 FROM "Question" q
    WHERE q."courseId" = c."id" AND q."practiceCollection" = 'QUESTION_BANK' AND q."deletedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "QuestionBankQuestion" qbq WHERE qbq."questionId" = q."id")
)
ON CONFLICT ("courseId", "slug") DO NOTHING;

INSERT INTO "QuestionBankQuestion" ("questionBankId", "questionId", "displayOrder")
SELECT qb."id", q."id", 0
FROM "QuestionBank" qb
JOIN "Question" q ON q."courseId" = qb."courseId"
WHERE qb."slug" = 'legacy-free-question-bank'
  AND q."practiceCollection" = 'QUESTION_BANK'
  AND q."deletedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "QuestionBankQuestion" existing WHERE existing."questionId" = q."id")
ON CONFLICT ("questionBankId", "questionId") DO NOTHING;
