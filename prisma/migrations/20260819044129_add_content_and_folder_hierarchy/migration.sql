-- CreateEnum
CREATE TYPE "ContentKind" AS ENUM ('FOLDER', 'FILE');

-- CreateEnum
CREATE TYPE "ContentAccessType" AS ENUM ('FREE', 'PAID');

-- CreateEnum
CREATE TYPE "ContentEntityType" AS ENUM ('EXAM', 'STAGE', 'SUBJECT', 'CHAPTER', 'COURSE', 'CATEGORY', 'LESSON', 'STUDY_MATERIAL', 'GOVERNMENT_DOCUMENT', 'QUESTION_PAPER', 'REFERENCE_MATERIAL', 'PREMIUM_NOTE', 'MEDIA', 'OTHER');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "ContentItem" (
    "id" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "parentId" UUID,
    "kind" "ContentKind" NOT NULL,
    "name" TEXT NOT NULL,
    "size" BIGINT NOT NULL DEFAULT 0,
    "mimeType" TEXT,
    "storagePath" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "entityType" "ContentEntityType",
    "accessType" "ContentAccessType" NOT NULL DEFAULT 'FREE',
    "price" DECIMAL(10,2),
    "status" "ContentStatus" NOT NULL DEFAULT 'PUBLISHED',
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "lastOpenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ContentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentLocationSetting" (
    "id" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "folderId" UUID,
    "pageHeading" TEXT NOT NULL DEFAULT 'untitled_page',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentLocationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentSampleImage" (
    "id" UUID NOT NULL,
    "contentId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentSampleImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentStoreSection" (
    "id" UUID NOT NULL,
    "contentId" UUID NOT NULL,
    "heading" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentStoreSection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentItem_courseId_parentId_deletedAt_displayOrder_idx" ON "ContentItem"("courseId", "parentId", "deletedAt", "displayOrder");

-- CreateIndex
CREATE INDEX "ContentItem_kind_accessType_idx" ON "ContentItem"("kind", "accessType");

-- CreateIndex
CREATE INDEX "ContentItem_status_idx" ON "ContentItem"("status");

-- CreateIndex
CREATE INDEX "ContentItem_storagePath_idx" ON "ContentItem"("storagePath");

-- CreateIndex
CREATE INDEX "ContentLocationSetting_courseId_idx" ON "ContentLocationSetting"("courseId");

-- AddForeignKey
ALTER TABLE "ContentItem" ADD CONSTRAINT "ContentItem_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentItem" ADD CONSTRAINT "ContentItem_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentLocationSetting" ADD CONSTRAINT "ContentLocationSetting_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentLocationSetting" ADD CONSTRAINT "ContentLocationSetting_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentSampleImage" ADD CONSTRAINT "ContentSampleImage_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "ContentItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentStoreSection" ADD CONSTRAINT "ContentStoreSection_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "ContentItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Custom Partial Unique Indexes for ContentLocationSetting

-- Root-level location setting uniqueness (where folderId IS NULL)
CREATE UNIQUE INDEX "ContentLocationSetting_course_root_key"
ON "ContentLocationSetting" ("courseId")
WHERE "folderId" IS NULL;

-- Folder-level location setting uniqueness (where folderId IS NOT NULL)
CREATE UNIQUE INDEX "ContentLocationSetting_course_folder_key"
ON "ContentLocationSetting" ("courseId", "folderId")
WHERE "folderId" IS NOT NULL;

-- Custom Case-Insensitive Functional Sibling Name Uniqueness Indexes (Active Items Only)

-- Root-level item name uniqueness (where parentId IS NULL and deletedAt IS NULL)
CREATE UNIQUE INDEX "ContentItem_courseId_root_name_ci_key"
ON "ContentItem" ("courseId", LOWER(BTRIM("name")))
WHERE "parentId" IS NULL
  AND "deletedAt" IS NULL;

-- Nested item name uniqueness (where parentId IS NOT NULL and deletedAt IS NULL)
CREATE UNIQUE INDEX "ContentItem_courseId_parentId_name_ci_key"
ON "ContentItem" ("courseId", "parentId", LOWER(BTRIM("name")))
WHERE "parentId" IS NOT NULL
  AND "deletedAt" IS NULL;
