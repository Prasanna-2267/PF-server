-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'ACTIVE', 'EXPIRED', 'ARCHIVED', 'DISABLED');

-- CreateEnum
CREATE TYPE "BroadcastType" AS ENUM ('ANNOUNCEMENT', 'IMPORTANT_NOTICE', 'UPDATE', 'PROMOTION', 'MAINTENANCE', 'FEATURE_UPDATE', 'ACADEMIC', 'STORE', 'GENERAL', 'CRITICAL_ALERT');

-- CreateEnum
CREATE TYPE "BroadcastPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "BroadcastAudienceKind" AS ENUM ('EVERYONE', 'STUDENTS', 'COURSES', 'PACKAGES', 'ACADEMIES', 'ACADEMY_STUDENTS');

-- CreateEnum
CREATE TYPE "BroadcastPlatform" AS ENUM ('APP', 'WEBSITE', 'BOTH');

-- CreateEnum
CREATE TYPE "BroadcastPlacement" AS ENUM ('NOTIFICATION', 'HOME', 'STORE', 'COURSE', 'GENERAL');

-- CreateEnum
CREATE TYPE "BroadcastFrequency" AS ENUM ('ONCE', 'DAILY', 'EVERY_VISIT', 'UNTIL_DISMISSED', 'ALWAYS_ACTIVE');

-- CreateEnum
CREATE TYPE "BroadcastCtaAction" AS ENUM ('INTERNAL_ROUTE', 'EXTERNAL_URL', 'STORE', 'COURSE', 'PACKAGE', 'CONTENT', 'ACADEMY');

-- CreateEnum
CREATE TYPE "BroadcastPresentation" AS ENUM ('BANNER', 'NOTIFICATION', 'CARD', 'MODAL', 'WHATS_NEW', 'CRITICAL_ALERT');

-- CreateEnum
CREATE TYPE "BroadcastDisplayOrder" AS ENUM ('AUTOMATIC', 'PINNED', 'CUSTOM');

-- CreateEnum
CREATE TYPE "BroadcastRepeatBehavior" AS ENUM ('NEVER', 'INTERVAL', 'CONTINUE');

-- CreateEnum
CREATE TYPE "BroadcastTimelineAction" AS ENUM ('CREATED', 'UPDATED', 'PUBLISHED', 'SCHEDULED', 'PAUSED', 'RESUMED', 'EXPIRED', 'ARCHIVED', 'DELETED', 'AUDIENCE_CHANGED', 'DISPLAY_CHANGED', 'CTA_CHANGED', 'SCHEDULE_CHANGED', 'PRIORITY_CHANGED', 'DISABLED', 'RESTORED');

-- CreateEnum
CREATE TYPE "BroadcastEventType" AS ENUM ('REACHED', 'VIEWED', 'CLICKED', 'DISMISSED', 'ACKNOWLEDGED');

-- CreateTable
CREATE TABLE "Broadcast" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT NOT NULL DEFAULT '',
    "message" TEXT NOT NULL,
    "type" "BroadcastType" NOT NULL DEFAULT 'ANNOUNCEMENT',
    "priority" "BroadcastPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "BroadcastStatus" NOT NULL DEFAULT 'DRAFT',
    "disabledFrom" "BroadcastStatus",
    "platform" "BroadcastPlatform" NOT NULL DEFAULT 'BOTH',
    "audienceKind" "BroadcastAudienceKind" NOT NULL DEFAULT 'EVERYONE',
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "frequency" "BroadcastFrequency" NOT NULL DEFAULT 'ONCE',
    "dismissible" BOOLEAN NOT NULL DEFAULT true,
    "presentation" "BroadcastPresentation" NOT NULL DEFAULT 'NOTIFICATION',
    "displayOrder" "BroadcastDisplayOrder" NOT NULL DEFAULT 'AUTOMATIC',
    "customOrderWeight" INTEGER NOT NULL DEFAULT 50,
    "acknowledgementRequired" BOOLEAN NOT NULL DEFAULT false,
    "repeatBehavior" "BroadcastRepeatBehavior" NOT NULL DEFAULT 'NEVER',
    "showInWhatsNew" BOOLEAN NOT NULL DEFAULT false,
    "reachedCount" INTEGER NOT NULL DEFAULT 0,
    "viewedCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueViewsCount" INTEGER NOT NULL DEFAULT 0,
    "clickedCount" INTEGER NOT NULL DEFAULT 0,
    "dismissedCount" INTEGER NOT NULL DEFAULT 0,
    "acknowledgedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastPlacementSetting" (
    "id" UUID NOT NULL,
    "broadcastId" UUID NOT NULL,
    "placement" "BroadcastPlacement" NOT NULL,

    CONSTRAINT "BroadcastPlacementSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastCta" (
    "id" UUID NOT NULL,
    "broadcastId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "text" TEXT NOT NULL,
    "action" "BroadcastCtaAction" NOT NULL DEFAULT 'INTERNAL_ROUTE',
    "destination" TEXT NOT NULL,

    CONSTRAINT "BroadcastCta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastImage" (
    "id" UUID NOT NULL,
    "broadcastId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BroadcastImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastCourseTarget" (
    "id" UUID NOT NULL,
    "broadcastId" UUID NOT NULL,
    "courseId" UUID NOT NULL,

    CONSTRAINT "BroadcastCourseTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastPackageTarget" (
    "id" UUID NOT NULL,
    "broadcastId" UUID NOT NULL,
    "packageId" UUID NOT NULL,

    CONSTRAINT "BroadcastPackageTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastTimelineEvent" (
    "id" UUID NOT NULL,
    "broadcastId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "action" "BroadcastTimelineAction" NOT NULL,
    "description" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BroadcastTimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastUserEvent" (
    "id" UUID NOT NULL,
    "broadcastId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "eventType" "BroadcastEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BroadcastUserEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes
CREATE INDEX "Broadcast_status_startAt_endAt_deletedAt_idx" ON "Broadcast"("status", "startAt", "endAt", "deletedAt");
CREATE INDEX "Broadcast_platform_audienceKind_idx" ON "Broadcast"("platform", "audienceKind");
CREATE INDEX "Broadcast_priority_displayOrder_idx" ON "Broadcast"("priority", "displayOrder");
CREATE INDEX "Broadcast_showInWhatsNew_status_idx" ON "Broadcast"("showInWhatsNew", "status");
CREATE INDEX "Broadcast_createdAt_idx" ON "Broadcast"("createdAt");

CREATE UNIQUE INDEX "BroadcastPlacementSetting_broadcastId_placement_key" ON "BroadcastPlacementSetting"("broadcastId", "placement");
CREATE INDEX "BroadcastPlacementSetting_broadcastId_idx" ON "BroadcastPlacementSetting"("broadcastId");
CREATE INDEX "BroadcastPlacementSetting_placement_idx" ON "BroadcastPlacementSetting"("placement");

CREATE UNIQUE INDEX "BroadcastCta_broadcastId_key" ON "BroadcastCta"("broadcastId");
CREATE UNIQUE INDEX "BroadcastImage_broadcastId_key" ON "BroadcastImage"("broadcastId");

CREATE UNIQUE INDEX "BroadcastCourseTarget_broadcastId_courseId_key" ON "BroadcastCourseTarget"("broadcastId", "courseId");
CREATE INDEX "BroadcastCourseTarget_broadcastId_idx" ON "BroadcastCourseTarget"("broadcastId");
CREATE INDEX "BroadcastCourseTarget_courseId_idx" ON "BroadcastCourseTarget"("courseId");

CREATE UNIQUE INDEX "BroadcastPackageTarget_broadcastId_packageId_key" ON "BroadcastPackageTarget"("broadcastId", "packageId");
CREATE INDEX "BroadcastPackageTarget_broadcastId_idx" ON "BroadcastPackageTarget"("broadcastId");
CREATE INDEX "BroadcastPackageTarget_packageId_idx" ON "BroadcastPackageTarget"("packageId");

CREATE INDEX "BroadcastTimelineEvent_broadcastId_timestamp_idx" ON "BroadcastTimelineEvent"("broadcastId", "timestamp");
CREATE INDEX "BroadcastTimelineEvent_actorId_idx" ON "BroadcastTimelineEvent"("actorId");

CREATE INDEX "BroadcastUserEvent_broadcastId_userId_eventType_idx" ON "BroadcastUserEvent"("broadcastId", "userId", "eventType");
CREATE INDEX "BroadcastUserEvent_broadcastId_eventType_idx" ON "BroadcastUserEvent"("broadcastId", "eventType");
CREATE INDEX "BroadcastUserEvent_userId_broadcastId_eventType_idx" ON "BroadcastUserEvent"("userId", "broadcastId", "eventType");
CREATE INDEX "BroadcastUserEvent_occurredAt_idx" ON "BroadcastUserEvent"("occurredAt");

-- Partial Unique Indexes for Single-Occurrence Events
CREATE UNIQUE INDEX "BroadcastUserEvent_broadcastId_userId_ack_key" ON "BroadcastUserEvent"("broadcastId", "userId") WHERE ("eventType" = 'ACKNOWLEDGED');
CREATE UNIQUE INDEX "BroadcastUserEvent_broadcastId_userId_dismiss_key" ON "BroadcastUserEvent"("broadcastId", "userId") WHERE ("eventType" = 'DISMISSED');
CREATE UNIQUE INDEX "BroadcastUserEvent_broadcastId_userId_reached_key" ON "BroadcastUserEvent"("broadcastId", "userId") WHERE ("eventType" = 'REACHED');

-- Add Foreign Keys
ALTER TABLE "BroadcastPlacementSetting" ADD CONSTRAINT "BroadcastPlacementSetting_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BroadcastCta" ADD CONSTRAINT "BroadcastCta_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BroadcastImage" ADD CONSTRAINT "BroadcastImage_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BroadcastCourseTarget" ADD CONSTRAINT "BroadcastCourseTarget_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BroadcastCourseTarget" ADD CONSTRAINT "BroadcastCourseTarget_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BroadcastPackageTarget" ADD CONSTRAINT "BroadcastPackageTarget_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BroadcastPackageTarget" ADD CONSTRAINT "BroadcastPackageTarget_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BroadcastTimelineEvent" ADD CONSTRAINT "BroadcastTimelineEvent_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BroadcastTimelineEvent" ADD CONSTRAINT "BroadcastTimelineEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BroadcastUserEvent" ADD CONSTRAINT "BroadcastUserEvent_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BroadcastUserEvent" ADD CONSTRAINT "BroadcastUserEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add Check Constraints
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_schedule_check" CHECK ("endAt" IS NULL OR "startAt" IS NULL OR "startAt" <= "endAt");
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_weight_check" CHECK ("customOrderWeight" >= 0 AND "customOrderWeight" <= 1000);
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_counters_check" CHECK ("reachedCount" >= 0 AND "viewedCount" >= 0 AND "uniqueViewsCount" >= 0 AND "clickedCount" >= 0 AND "dismissedCount" >= 0 AND "acknowledgedCount" >= 0);
