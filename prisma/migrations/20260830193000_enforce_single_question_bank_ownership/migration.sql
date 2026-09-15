-- Finalise Question Bank ownership without resetting or rewriting existing data.
-- The legacy join table is retained physically for rollback compatibility, but
-- all active application code uses Question.questionBankId from this point.
ALTER TABLE "Question" ADD COLUMN "questionBankId" UUID;

-- Existing links are expected to be one-per-question. If older data contains
-- more than one, retain the earliest deterministic link; the question itself is
-- not duplicated or deleted by this migration.
UPDATE "Question" q
SET "questionBankId" = chosen."questionBankId"
FROM (
  SELECT DISTINCT ON ("questionId") "questionId", "questionBankId"
  FROM "QuestionBankQuestion"
  ORDER BY "questionId", "addedAt" ASC, "questionBankId" ASC
) chosen
WHERE chosen."questionId" = q."id";

CREATE INDEX "Question_questionBankId_status_deletedAt_idx"
  ON "Question"("questionBankId", "status", "deletedAt");

ALTER TABLE "Question"
  ADD CONSTRAINT "Question_questionBankId_fkey"
  FOREIGN KEY ("questionBankId") REFERENCES "QuestionBank"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every question classified as QUESTION_BANK must have exactly one owning bank.
-- Non-bank course MCQs remain valid without a bank.
ALTER TABLE "Question"
  ADD CONSTRAINT "Question_question_bank_owner_required"
  CHECK (
    "practiceCollection" <> 'QUESTION_BANK'::"PracticeCollection"
    OR "questionBankId" IS NOT NULL
  );
