-- Extend the existing normalized practice engine without replacing any
-- sessions or attempts already stored in the shared database.
ALTER TYPE "PracticeCollection" ADD VALUE IF NOT EXISTS 'QUESTION_BANK';

CREATE TYPE "PracticeMode" AS ENUM ('MCQ', 'CASE_STUDY', 'QUESTION_BANK', 'WRONG_ANSWERS');

ALTER TABLE "PracticeSession"
ADD COLUMN "mode" "PracticeMode" NOT NULL DEFAULT 'MCQ';

CREATE TABLE "PracticeSessionMaterial" (
    "sessionId" UUID NOT NULL,
    "contentItemId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PracticeSessionMaterial_pkey" PRIMARY KEY ("sessionId", "contentItemId")
);

CREATE INDEX "PracticeSessionMaterial_contentItemId_sessionId_idx"
ON "PracticeSessionMaterial"("contentItemId", "sessionId");

ALTER TABLE "PracticeSessionMaterial"
ADD CONSTRAINT "PracticeSessionMaterial_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "PracticeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PracticeSessionMaterial"
ADD CONSTRAINT "PracticeSessionMaterial_contentItemId_fkey"
FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
