CREATE TYPE "NoteViewerSessionStatus" AS ENUM ('ACTIVE', 'CLOSED', 'EXPIRED');

CREATE TABLE "NoteViewerSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "userSessionId" UUID NOT NULL,
    "contentItemId" UUID NOT NULL,
    "traceId" VARCHAR(32) NOT NULL,
    "status" "NoteViewerSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "pageCount" INTEGER,
    "currentPage" INTEGER,
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "scrollOffset" DOUBLE PRECISION,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoteViewerSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NoteViewerSession_traceId_key" ON "NoteViewerSession"("traceId");
CREATE INDEX "NoteViewerSession_userId_status_lastSeenAt_idx" ON "NoteViewerSession"("userId", "status", "lastSeenAt");
CREATE INDEX "NoteViewerSession_contentItemId_openedAt_idx" ON "NoteViewerSession"("contentItemId", "openedAt");
CREATE INDEX "NoteViewerSession_userSessionId_status_idx" ON "NoteViewerSession"("userSessionId", "status");
CREATE INDEX "NoteViewerSession_expiresAt_status_idx" ON "NoteViewerSession"("expiresAt", "status");

ALTER TABLE "NoteViewerSession"
ADD CONSTRAINT "NoteViewerSession_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NoteViewerSession"
ADD CONSTRAINT "NoteViewerSession_userSessionId_fkey"
FOREIGN KEY ("userSessionId") REFERENCES "UserSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NoteViewerSession"
ADD CONSTRAINT "NoteViewerSession_contentItemId_fkey"
FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
