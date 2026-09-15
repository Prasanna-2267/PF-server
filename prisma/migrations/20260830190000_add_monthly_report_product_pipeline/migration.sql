ALTER TYPE "ContentEntityType" ADD VALUE IF NOT EXISTS 'MONTHLY_REPORT';
ALTER TYPE "LearningResourceType" ADD VALUE IF NOT EXISTS 'MONTHLY_REPORT';

DO $$ BEGIN
  CREATE TYPE "MonthlyReportStatus" AS ENUM ('PENDING', 'GENERATING', 'READY', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "LearnerMonthlyReport"
  ADD COLUMN IF NOT EXISTS "productContentItemId" UUID,
  ADD COLUMN IF NOT EXISTS "entitlementId" UUID,
  ADD COLUMN IF NOT EXISTS "orderId" UUID,
  ADD COLUMN IF NOT EXISTS "status" "MonthlyReportStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "snapshotJson" JSONB,
  ADD COLUMN IF NOT EXISTS "sourceDataHash" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "storageKey" TEXT,
  ADD COLUMN IF NOT EXISTS "pdfChecksumSha256" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "pdfSizeBytes" BIGINT,
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "failureCode" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "generatedAt" DROP DEFAULT,
  ALTER COLUMN "generatedAt" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS "LearnerMonthlyReport_userId_status_periodStart_idx"
  ON "LearnerMonthlyReport"("userId", "status", "periodStart");
CREATE INDEX IF NOT EXISTS "LearnerMonthlyReport_entitlementId_idx" ON "LearnerMonthlyReport"("entitlementId");
CREATE INDEX IF NOT EXISTS "LearnerMonthlyReport_orderId_idx" ON "LearnerMonthlyReport"("orderId");

DO $$ BEGIN
  ALTER TABLE "LearnerMonthlyReport" ADD CONSTRAINT "LearnerMonthlyReport_productContentItemId_fkey"
    FOREIGN KEY ("productContentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "LearnerMonthlyReport" ADD CONSTRAINT "LearnerMonthlyReport_entitlementId_fkey"
    FOREIGN KEY ("entitlementId") REFERENCES "Entitlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "LearnerMonthlyReport" ADD CONSTRAINT "LearnerMonthlyReport_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "MonthlyReportViewerSession" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "userSessionId" UUID NOT NULL,
  "reportId" UUID NOT NULL,
  "traceId" VARCHAR(32) NOT NULL,
  "status" "NoteViewerSessionStatus" NOT NULL DEFAULT 'ACTIVE',
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "closedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MonthlyReportViewerSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MonthlyReportViewerSession_traceId_key" ON "MonthlyReportViewerSession"("traceId");
CREATE INDEX IF NOT EXISTS "MonthlyReportViewerSession_userId_status_lastSeenAt_idx" ON "MonthlyReportViewerSession"("userId", "status", "lastSeenAt");
CREATE INDEX IF NOT EXISTS "MonthlyReportViewerSession_reportId_openedAt_idx" ON "MonthlyReportViewerSession"("reportId", "openedAt");
CREATE INDEX IF NOT EXISTS "MonthlyReportViewerSession_userSessionId_status_idx" ON "MonthlyReportViewerSession"("userSessionId", "status");
CREATE INDEX IF NOT EXISTS "MonthlyReportViewerSession_expiresAt_status_idx" ON "MonthlyReportViewerSession"("expiresAt", "status");

DO $$ BEGIN
  ALTER TABLE "MonthlyReportViewerSession" ADD CONSTRAINT "MonthlyReportViewerSession_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "MonthlyReportViewerSession" ADD CONSTRAINT "MonthlyReportViewerSession_userSessionId_fkey"
    FOREIGN KEY ("userSessionId") REFERENCES "UserSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "MonthlyReportViewerSession" ADD CONSTRAINT "MonthlyReportViewerSession_reportId_fkey"
    FOREIGN KEY ("reportId") REFERENCES "LearnerMonthlyReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ContentItem_monthly_report_course_unique"
  ON "ContentItem"("courseId")
  WHERE "entityType" = 'MONTHLY_REPORT' AND "deletedAt" IS NULL;

INSERT INTO "ContentItem" (
  "id", "courseId", "parentId", "kind", "name", "size", "mimeType", "storagePath",
  "description", "entityType", "accessType", "price", "validityMode", "validityOffsetDays",
  "status", "displayOrder", "createdAt", "updatedAt", "deletedAt"
)
SELECT
  gen_random_uuid(), c."id", NULL, 'FOLDER', 'Monthly Report', 0,
  NULL, NULL,
  'A professionally generated monthly learning report with practice, progress, consistency and test insights.',
  'MONTHLY_REPORT', 'PAID', 99.00, 'PERMANENT', NULL, 'PUBLISHED', 9999,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL
FROM "Course" c
WHERE c."status" = 'ACTIVE' AND c."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "ContentItem" ci
    WHERE ci."courseId" = c."id" AND ci."entityType" = 'MONTHLY_REPORT' AND ci."deletedAt" IS NULL
  );
