CREATE TYPE "NoteRevisionSource" AS ENUM ('ACTION_SHEET', 'READER', 'MANUAL');

CREATE TABLE "LearnerNoteState" (
    "userId" UUID NOT NULL,
    "contentItemId" UUID NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "favourite" BOOLEAN NOT NULL DEFAULT false,
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "currentPage" INTEGER,
    "scrollOffset" DOUBLE PRECISION,
    "firstOpenedAt" TIMESTAMP(3),
    "lastOpenedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "revisionCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearnerNoteState_pkey" PRIMARY KEY ("userId", "contentItemId")
);

CREATE TABLE "NoteRevisionEvent" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "contentItemId" UUID NOT NULL,
    "source" "NoteRevisionSource" NOT NULL DEFAULT 'ACTION_SHEET',
    "revisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoteRevisionEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LearnerNoteState_userId_favourite_updatedAt_idx" ON "LearnerNoteState"("userId", "favourite", "updatedAt");
CREATE INDEX "LearnerNoteState_userId_completed_updatedAt_idx" ON "LearnerNoteState"("userId", "completed", "updatedAt");
CREATE INDEX "LearnerNoteState_userId_lastOpenedAt_idx" ON "LearnerNoteState"("userId", "lastOpenedAt");
CREATE INDEX "LearnerNoteState_contentItemId_idx" ON "LearnerNoteState"("contentItemId");
CREATE INDEX "NoteRevisionEvent_userId_revisedAt_idx" ON "NoteRevisionEvent"("userId", "revisedAt");
CREATE INDEX "NoteRevisionEvent_contentItemId_revisedAt_idx" ON "NoteRevisionEvent"("contentItemId", "revisedAt");

ALTER TABLE "LearnerNoteState"
ADD CONSTRAINT "LearnerNoteState_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LearnerNoteState"
ADD CONSTRAINT "LearnerNoteState_contentItemId_fkey"
FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NoteRevisionEvent"
ADD CONSTRAINT "NoteRevisionEvent_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NoteRevisionEvent"
ADD CONSTRAINT "NoteRevisionEvent_userId_contentItemId_fkey"
FOREIGN KEY ("userId", "contentItemId") REFERENCES "LearnerNoteState"("userId", "contentItemId") ON DELETE CASCADE ON UPDATE CASCADE;
