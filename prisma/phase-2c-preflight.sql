-- READ-ONLY Phase 2C migration preflight. Run against a staging clone first.
-- Every result set must be empty (or false where stated) before migrate deploy.

-- The migration must be wholly unapplied. Any true value suggests partial/manual drift.
SELECT to_regclass('public."StorageUpload"') IS NOT NULL AS storage_upload_already_exists,
       to_regclass('public."BackgroundJob"') IS NOT NULL AS background_job_already_exists,
       to_regclass('public."PaymentWebhookEvent"') IS NOT NULL AS webhook_event_already_exists;

-- New invitation uniqueness requirement.
SELECT "academyId", lower("email") AS normalized_email, count(*) AS duplicate_count
FROM "AcademyInvitation"
WHERE "status" = 'PENDING'
GROUP BY "academyId", lower("email")
HAVING count(*) > 1;

-- New content integrity requirement.
SELECT "id", "kind", "storagePath", "mimeType"
FROM "ContentItem"
WHERE NOT (("kind" = 'FOLDER' AND "storagePath" IS NULL AND "mimeType" IS NULL)
        OR ("kind" = 'FILE' AND "storagePath" IS NOT NULL AND "mimeType" IS NOT NULL));

-- New question-option parent integrity requirement.
SELECT "id", "questionId", "subQuestionId"
FROM "QuestionOption"
WHERE num_nonnulls("questionId", "subQuestionId") <> 1;

-- Existing domain constraints and indexes that Phase 2C relies on.
SELECT required.object_name
FROM (VALUES
  ('Package_courseId_slug_key'),
  ('QuestionOption_questionId_optionLabel_key'),
  ('QuestionOption_subQuestionId_optionLabel_key'),
  ('ContentLocationSetting_course_root_key'),
  ('ContentLocationSetting_course_folder_key')
) AS required(object_name)
WHERE to_regclass('public.' || quote_ident(required.object_name)) IS NULL;

-- Migration ledger continuity. Inspect results; do not repair manually.
SELECT migration_name, finished_at, rolled_back_at, logs
FROM "_prisma_migrations"
ORDER BY started_at;
