-- Additive, backward-compatible relationship between the existing Questions
-- and Content modules. No existing rows are changed or deleted.
CREATE TABLE "QuestionContentLink" (
    "questionId" UUID NOT NULL,
    "contentItemId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionContentLink_pkey" PRIMARY KEY ("questionId", "contentItemId")
);

CREATE INDEX "QuestionContentLink_contentItemId_questionId_idx"
    ON "QuestionContentLink"("contentItemId", "questionId");

ALTER TABLE "QuestionContentLink"
    ADD CONSTRAINT "QuestionContentLink_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "Question"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QuestionContentLink"
    ADD CONSTRAINT "QuestionContentLink_contentItemId_fkey"
    FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
