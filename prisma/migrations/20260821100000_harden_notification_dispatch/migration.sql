-- Additive notification dispatch recovery and explicit target persistence.
-- Do not deploy until the production migration history has been reconciled.

ALTER TABLE "Notification"
ADD COLUMN "processingStartedAt" TIMESTAMP(3),
ADD COLUMN "dispatchAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastDispatchError" TEXT;

CREATE TABLE "NotificationIndividualTarget" (
    "notificationId" UUID NOT NULL,
    "studentUserId" UUID NOT NULL,
    "academyId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationIndividualTarget_pkey" PRIMARY KEY ("notificationId", "studentUserId")
);

CREATE INDEX "NotificationIndividualTarget_academyId_studentUserId_idx"
ON "NotificationIndividualTarget"("academyId", "studentUserId");

ALTER TABLE "NotificationIndividualTarget" ADD CONSTRAINT "NotificationIndividualTarget_notificationId_fkey"
FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationIndividualTarget" ADD CONSTRAINT "NotificationIndividualTarget_studentUserId_fkey"
FOREIGN KEY ("studentUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NotificationIndividualTarget" ADD CONSTRAINT "NotificationIndividualTarget_academyId_fkey"
FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
