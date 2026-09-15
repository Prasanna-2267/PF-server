CREATE TYPE "StudyPlanTaskType" AS ENUM ('READ_NOTE', 'CONTINUE_NOTE', 'REVISE_NOTE', 'MANUAL');
CREATE TYPE "StudyPlanTaskSource" AS ENUM ('SYLLABUS_PLAN', 'REVISION_DUE', 'CONTINUE_RESOURCE', 'CARRY_OVER', 'MANUAL');
CREATE TYPE "StudyPlanTaskStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED', 'RESCHEDULED', 'REPLACED');
CREATE TYPE "StudyEstimateSource" AS ENUM ('ADMIN', 'FALLBACK_V1', 'LEARNER');

CREATE TABLE "LearnerStudyPlan" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "courseId" UUID NOT NULL,
  "localDate" DATE NOT NULL,
  "timezone" VARCHAR(80) NOT NULL,
  "availableMinutes" INTEGER NOT NULL,
  "algorithmVersion" VARCHAR(80) NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LearnerStudyPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LearnerStudyTask" (
  "id" UUID NOT NULL,
  "planId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "contentItemId" UUID,
  "type" "StudyPlanTaskType" NOT NULL,
  "source" "StudyPlanTaskSource" NOT NULL,
  "status" "StudyPlanTaskStatus" NOT NULL DEFAULT 'PLANNED',
  "estimateSource" "StudyEstimateSource" NOT NULL,
  "title" VARCHAR(180) NOT NULL,
  "reason" VARCHAR(320) NOT NULL,
  "plannedMinutes" INTEGER NOT NULL,
  "actualMinutes" INTEGER,
  "priority" INTEGER NOT NULL,
  "sequence" INTEGER NOT NULL,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "skippedAt" TIMESTAMP(3),
  "rescheduledForDate" DATE,
  "hiddenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LearnerStudyTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StudyWorkloadEstimate" (
  "contentItemId" UUID NOT NULL,
  "estimatedReadingMinutes" INTEGER NOT NULL,
  "estimatedRevisionMinutes" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StudyWorkloadEstimate_pkey" PRIMARY KEY ("contentItemId")
);

CREATE UNIQUE INDEX "LearnerStudyPlan_userId_localDate_key" ON "LearnerStudyPlan"("userId", "localDate");
CREATE INDEX "LearnerStudyPlan_userId_localDate_idx" ON "LearnerStudyPlan"("userId", "localDate");
CREATE INDEX "LearnerStudyPlan_courseId_localDate_idx" ON "LearnerStudyPlan"("courseId", "localDate");
CREATE INDEX "LearnerStudyTask_userId_status_updatedAt_idx" ON "LearnerStudyTask"("userId", "status", "updatedAt");
CREATE INDEX "LearnerStudyTask_planId_sequence_idx" ON "LearnerStudyTask"("planId", "sequence");
CREATE INDEX "LearnerStudyTask_contentItemId_status_idx" ON "LearnerStudyTask"("contentItemId", "status");
CREATE INDEX "LearnerStudyTask_rescheduledForDate_idx" ON "LearnerStudyTask"("rescheduledForDate");
CREATE INDEX "StudyWorkloadEstimate_updatedAt_idx" ON "StudyWorkloadEstimate"("updatedAt");

ALTER TABLE "LearnerStudyPlan" ADD CONSTRAINT "LearnerStudyPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearnerStudyPlan" ADD CONSTRAINT "LearnerStudyPlan_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LearnerStudyTask" ADD CONSTRAINT "LearnerStudyTask_planId_fkey" FOREIGN KEY ("planId") REFERENCES "LearnerStudyPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearnerStudyTask" ADD CONSTRAINT "LearnerStudyTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearnerStudyTask" ADD CONSTRAINT "LearnerStudyTask_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StudyWorkloadEstimate" ADD CONSTRAINT "StudyWorkloadEstimate_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearnerStudyPlan" ADD CONSTRAINT "LearnerStudyPlan_availableMinutes_check" CHECK ("availableMinutes" BETWEEN 15 AND 720);
ALTER TABLE "LearnerStudyTask" ADD CONSTRAINT "LearnerStudyTask_plannedMinutes_check" CHECK ("plannedMinutes" BETWEEN 5 AND 720);
ALTER TABLE "LearnerStudyTask" ADD CONSTRAINT "LearnerStudyTask_actualMinutes_check" CHECK ("actualMinutes" IS NULL OR "actualMinutes" BETWEEN 0 AND 1440);
ALTER TABLE "StudyWorkloadEstimate" ADD CONSTRAINT "StudyWorkloadEstimate_minutes_check" CHECK ("estimatedReadingMinutes" BETWEEN 5 AND 1440 AND "estimatedRevisionMinutes" BETWEEN 5 AND 1440);
