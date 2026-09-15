-- CreateEnum
CREATE TYPE "SecurityEventType" AS ENUM ('LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGOUT', 'SESSION_CREATED', 'SESSION_REVOKED', 'PASSWORD_CHANGED', 'ACCOUNT_DISABLED', 'ACCOUNT_ENABLED', 'SUSPICIOUS_ACTIVITY', 'QR_AUTH_SUCCESS', 'QR_AUTH_FAILED');

-- CreateEnum
CREATE TYPE "SecurityRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateTable
CREATE TABLE "SystemAuditLog" (
    "id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "actorId" UUID,
    "academyId" UUID,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" UUID NOT NULL,
    "eventType" "SecurityEventType" NOT NULL,
    "riskLevel" "SecurityRiskLevel" NOT NULL DEFAULT 'LOW',
    "description" TEXT NOT NULL DEFAULT '',
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "sessionId" UUID,
    "userId" UUID,
    "actorId" UUID,
    "academyId" UUID,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SystemAuditLog_actorId_idx" ON "SystemAuditLog"("actorId");

-- CreateIndex
CREATE INDEX "SystemAuditLog_academyId_idx" ON "SystemAuditLog"("academyId");

-- CreateIndex
CREATE INDEX "SystemAuditLog_entityType_entityId_idx" ON "SystemAuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "SystemAuditLog_occurredAt_idx" ON "SystemAuditLog"("occurredAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_userId_idx" ON "SecurityEvent"("userId");

-- CreateIndex
CREATE INDEX "SecurityEvent_actorId_idx" ON "SecurityEvent"("actorId");

-- CreateIndex
CREATE INDEX "SecurityEvent_academyId_idx" ON "SecurityEvent"("academyId");

-- CreateIndex
CREATE INDEX "SecurityEvent_eventType_idx" ON "SecurityEvent"("eventType");

-- CreateIndex
CREATE INDEX "SecurityEvent_riskLevel_idx" ON "SecurityEvent"("riskLevel");

-- CreateIndex
CREATE INDEX "SecurityEvent_occurredAt_idx" ON "SecurityEvent"("occurredAt");

-- AddForeignKey
ALTER TABLE "SystemAuditLog" ADD CONSTRAINT "SystemAuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemAuditLog" ADD CONSTRAINT "SystemAuditLog_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
