-- CreateEnum
CREATE TYPE "AdmissionMethod" AS ENUM ('BULK_IMPORT', 'QR_CODE', 'ADMISSION_CODE');

-- CreateEnum
CREATE TYPE "AdmissionStatus" AS ENUM ('SUCCESS', 'ALREADY_ADMITTED', 'FAILED');

-- CreateEnum
CREATE TYPE "AdmissionCodeStatus" AS ENUM ('ACTIVE', 'EXHAUSTED', 'EXPIRED', 'REVOKED');

-- CreateTable
CREATE TABLE "AdmissionBatch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "academyId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdmissionBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionRecord" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "academyId" UUID NOT NULL,
    "batchId" UUID,
    "studentId" UUID,
    "email" TEXT NOT NULL,
    "studentName" TEXT NOT NULL DEFAULT '',
    "method" "AdmissionMethod" NOT NULL,
    "codeId" UUID,
    "status" "AdmissionStatus" NOT NULL DEFAULT 'SUCCESS',
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdmissionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionCode" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "academyId" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "maxUses" INTEGER NOT NULL,
    "currentUses" INTEGER NOT NULL DEFAULT 0,
    "status" "AdmissionCodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdmissionCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdmissionBatch_academyId_createdAt_idx" ON "AdmissionBatch"("academyId", "createdAt");

-- CreateIndex
CREATE INDEX "AdmissionRecord_academyId_method_createdAt_idx" ON "AdmissionRecord"("academyId", "method", "createdAt");

-- CreateIndex
CREATE INDEX "AdmissionRecord_email_idx" ON "AdmissionRecord"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionCode_code_key" ON "AdmissionCode"("code");

-- CreateIndex
CREATE INDEX "AdmissionCode_academyId_status_expiresAt_idx" ON "AdmissionCode"("academyId", "status", "expiresAt");

-- AddForeignKey
ALTER TABLE "AdmissionBatch" ADD CONSTRAINT "AdmissionBatch_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionBatch" ADD CONSTRAINT "AdmissionBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionRecord" ADD CONSTRAINT "AdmissionRecord_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionRecord" ADD CONSTRAINT "AdmissionRecord_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "AdmissionBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionRecord" ADD CONSTRAINT "AdmissionRecord_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionRecord" ADD CONSTRAINT "AdmissionRecord_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "AdmissionCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionCode" ADD CONSTRAINT "AdmissionCode_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionCode" ADD CONSTRAINT "AdmissionCode_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
