-- Store merchandising and sample-image metadata were added to the Prisma
-- schema after the original content migrations. This additive migration keeps
-- existing content and commerce records intact.

CREATE TYPE "SampleImageRole" AS ENUM ('PDF_FIRST_PAGE', 'ADMIN_PREVIEW');

CREATE TYPE "MerchandisingMode" AS ENUM ('AUTO', 'HYBRID', 'MANUAL');

ALTER TYPE "AcademyStatus" ADD VALUE 'ARCHIVED';

ALTER TABLE "ContentSampleImage"
ADD COLUMN "role" "SampleImageRole" NOT NULL DEFAULT 'ADMIN_PREVIEW';

CREATE INDEX "ContentSampleImage_contentId_role_idx"
ON "ContentSampleImage"("contentId", "role");

CREATE TABLE "StoreMerchandisingSection" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "mode" "MerchandisingMode" NOT NULL DEFAULT 'AUTO',
    "limit" INTEGER NOT NULL DEFAULT 8,
    "dateWindowDays" INTEGER,
    "pinnedItemIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludedItemIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreMerchandisingSection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StoreMerchandisingSection_key_key"
ON "StoreMerchandisingSection"("key");
