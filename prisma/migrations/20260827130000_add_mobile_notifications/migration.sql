CREATE TYPE "MobilePushPlatform" AS ENUM ('ANDROID', 'IOS');
CREATE TYPE "LearnerNotificationCategory" AS ENUM ('BROADCAST', 'DAILY_PLAN', 'REVISION_DUE', 'RESOURCE_EXPIRY', 'STREAK_RISK', 'SECURITY', 'ACCOUNT');
CREATE TYPE "LearnerNotificationDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'CANCELLED');

CREATE TABLE "MobilePushToken" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "token" VARCHAR(220) NOT NULL,
  "platform" "MobilePushPlatform" NOT NULL,
  "installationId" VARCHAR(160) NOT NULL,
  "deviceName" VARCHAR(160),
  "appVersion" VARCHAR(40),
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "consecutiveErrors" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MobilePushToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LearnerNotificationPreference" (
  "userId" UUID NOT NULL,
  "pushEnabled" BOOLEAN NOT NULL DEFAULT true,
  "broadcastEnabled" BOOLEAN NOT NULL DEFAULT true,
  "dailyPlanEnabled" BOOLEAN NOT NULL DEFAULT true,
  "revisionDueEnabled" BOOLEAN NOT NULL DEFAULT true,
  "resourceExpiryEnabled" BOOLEAN NOT NULL DEFAULT true,
  "streakRiskEnabled" BOOLEAN NOT NULL DEFAULT true,
  "securityEnabled" BOOLEAN NOT NULL DEFAULT true,
  "accountEnabled" BOOLEAN NOT NULL DEFAULT true,
  "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT false,
  "quietHoursStart" VARCHAR(5) NOT NULL DEFAULT '22:00',
  "quietHoursEnd" VARCHAR(5) NOT NULL DEFAULT '07:00',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LearnerNotificationPreference_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "LearnerNotification" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "category" "LearnerNotificationCategory" NOT NULL,
  "title" VARCHAR(180) NOT NULL,
  "body" TEXT NOT NULL,
  "sourceKey" VARCHAR(240) NOT NULL,
  "data" JSONB,
  "scheduledFor" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LearnerNotification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LearnerNotificationPushDelivery" (
  "id" UUID NOT NULL,
  "notificationId" UUID NOT NULL,
  "pushTokenId" UUID NOT NULL,
  "status" "LearnerNotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "providerMessageId" TEXT,
  "lastError" TEXT,
  "nextAttemptAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LearnerNotificationPushDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MobilePushToken_token_key" ON "MobilePushToken"("token");
CREATE UNIQUE INDEX "MobilePushToken_userId_installationId_key" ON "MobilePushToken"("userId", "installationId");
CREATE INDEX "MobilePushToken_userId_enabled_revokedAt_idx" ON "MobilePushToken"("userId", "enabled", "revokedAt");
CREATE UNIQUE INDEX "LearnerNotification_userId_sourceKey_key" ON "LearnerNotification"("userId", "sourceKey");
CREATE INDEX "LearnerNotification_userId_readAt_createdAt_idx" ON "LearnerNotification"("userId", "readAt", "createdAt");
CREATE INDEX "LearnerNotification_category_scheduledFor_idx" ON "LearnerNotification"("category", "scheduledFor");
CREATE UNIQUE INDEX "LearnerNotificationPushDelivery_notificationId_pushTokenId_key" ON "LearnerNotificationPushDelivery"("notificationId", "pushTokenId");
CREATE INDEX "LearnerNotificationPushDelivery_status_nextAttemptAt_idx" ON "LearnerNotificationPushDelivery"("status", "nextAttemptAt");
CREATE INDEX "LearnerNotificationPushDelivery_pushTokenId_createdAt_idx" ON "LearnerNotificationPushDelivery"("pushTokenId", "createdAt");

ALTER TABLE "MobilePushToken" ADD CONSTRAINT "MobilePushToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearnerNotificationPreference" ADD CONSTRAINT "LearnerNotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearnerNotification" ADD CONSTRAINT "LearnerNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearnerNotificationPushDelivery" ADD CONSTRAINT "LearnerNotificationPushDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "LearnerNotification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearnerNotificationPushDelivery" ADD CONSTRAINT "LearnerNotificationPushDelivery_pushTokenId_fkey" FOREIGN KEY ("pushTokenId") REFERENCES "MobilePushToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;
