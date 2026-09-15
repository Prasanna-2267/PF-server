-- Run only after phase-2c-preflight.sql returns no violating rows and the
-- Phase 2C migration has successfully deployed to staging.
ALTER TABLE "ContentItem" VALIDATE CONSTRAINT "ContentItem_kind_storage_check";
ALTER TABLE "QuestionOption" VALIDATE CONSTRAINT "QuestionOption_single_parent_check";
