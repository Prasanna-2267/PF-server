-- CreateEnum
CREATE TYPE "PlatformSettingCategory" AS ENUM ('GENERAL', 'BRANDING', 'MAINTENANCE', 'STORE', 'NOTIFICATIONS', 'LEGAL');

-- CreateEnum
CREATE TYPE "FeatureFlagAudience" AS ENUM ('EVERYONE', 'STUDENTS', 'ADMINS', 'ACADEMIES');

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "category" "PlatformSettingCategory" NOT NULL DEFAULT 'GENERAL',
    "description" TEXT NOT NULL DEFAULT '',
    "updatedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformFeatureFlag" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "targetAudience" "FeatureFlagAudience" NOT NULL DEFAULT 'EVERYONE',
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformFeatureFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformSetting_key_key" ON "PlatformSetting"("key");

-- CreateIndex
CREATE INDEX "PlatformSetting_category_idx" ON "PlatformSetting"("category");

-- CreateIndex
CREATE INDEX "PlatformSetting_updatedById_idx" ON "PlatformSetting"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformFeatureFlag_key_key" ON "PlatformFeatureFlag"("key");

-- CreateIndex
CREATE INDEX "PlatformFeatureFlag_isEnabled_idx" ON "PlatformFeatureFlag"("isEnabled");

-- CreateIndex
CREATE INDEX "PlatformFeatureFlag_targetAudience_idx" ON "PlatformFeatureFlag"("targetAudience");

-- AddForeignKey
ALTER TABLE "PlatformSetting" ADD CONSTRAINT "PlatformSetting_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
