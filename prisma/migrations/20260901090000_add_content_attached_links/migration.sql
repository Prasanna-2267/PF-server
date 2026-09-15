CREATE TABLE "ContentAttachedLink" (
    "id" UUID NOT NULL,
    "contentItemId" UUID NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ContentAttachedLink_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContentAttachedLink_contentItemId_deletedAt_createdAt_idx"
    ON "ContentAttachedLink"("contentItemId", "deletedAt", "createdAt");

CREATE INDEX "ContentAttachedLink_createdById_idx"
    ON "ContentAttachedLink"("createdById");

CREATE UNIQUE INDEX "ContentAttachedLink_active_url_key"
    ON "ContentAttachedLink"("contentItemId", "url")
    WHERE "deletedAt" IS NULL;

ALTER TABLE "ContentAttachedLink"
    ADD CONSTRAINT "ContentAttachedLink_contentItemId_fkey"
    FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContentAttachedLink"
    ADD CONSTRAINT "ContentAttachedLink_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
