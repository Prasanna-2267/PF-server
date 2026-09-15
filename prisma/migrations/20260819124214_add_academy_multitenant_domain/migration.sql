-- CreateEnum
CREATE TYPE "AcademyStatus" AS ENUM ('ACTIVE', 'PENDING', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "AcademyMemberRole" AS ENUM ('ACADEMY_ADMIN', 'ACADEMY_TEACHER', 'ACADEMY_STUDENT');

-- CreateEnum
CREATE TYPE "AcademyMemberStatus" AS ENUM ('ACTIVE', 'INVITED', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AcademyInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- CreateTable
CREATE TABLE "Academy" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'India',
    "postalCode" TEXT NOT NULL,
    "website" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "status" "AcademyStatus" NOT NULL DEFAULT 'PENDING',
    "adminName" TEXT NOT NULL,
    "adminEmail" TEXT NOT NULL,
    "adminPhone" TEXT NOT NULL DEFAULT '',
    "studentCount" INTEGER NOT NULL DEFAULT 0,
    "activeStudentCount" INTEGER NOT NULL DEFAULT 0,
    "courseCount" INTEGER NOT NULL DEFAULT 0,
    "activeCourseCount" INTEGER NOT NULL DEFAULT 0,
    "packageCount" INTEGER NOT NULL DEFAULT 0,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Academy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyMembership" (
    "id" UUID NOT NULL,
    "academyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "AcademyMemberRole" NOT NULL DEFAULT 'ACADEMY_STUDENT',
    "status" "AcademyMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademyMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyInvitation" (
    "id" UUID NOT NULL,
    "academyId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "studentName" TEXT NOT NULL DEFAULT '',
    "role" "AcademyMemberRole" NOT NULL DEFAULT 'ACADEMY_STUDENT',
    "status" "AcademyInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invitedBy" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademyInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyQrSession" (
    "id" UUID NOT NULL,
    "academyId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademyQrSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyCourse" (
    "id" UUID NOT NULL,
    "academyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AcademyCourse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyContent" (
    "id" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "mimeType" TEXT,
    "size" BIGINT NOT NULL DEFAULT 0,
    "storagePath" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AcademyContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastAcademyTarget" (
    "id" UUID NOT NULL,
    "broadcastId" UUID NOT NULL,
    "academyId" UUID NOT NULL,

    CONSTRAINT "BroadcastAcademyTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Academy_slug_key" ON "Academy"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Academy_email_key" ON "Academy"("email");

-- CreateIndex
CREATE INDEX "Academy_status_deletedAt_idx" ON "Academy"("status", "deletedAt");

-- CreateIndex
CREATE INDEX "Academy_email_idx" ON "Academy"("email");

-- CreateIndex
CREATE INDEX "AcademyMembership_academyId_role_status_idx" ON "AcademyMembership"("academyId", "role", "status");

-- CreateIndex
CREATE INDEX "AcademyMembership_userId_status_idx" ON "AcademyMembership"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AcademyMembership_userId_academyId_key" ON "AcademyMembership"("userId", "academyId");

-- CreateIndex
CREATE INDEX "AcademyInvitation_academyId_email_status_idx" ON "AcademyInvitation"("academyId", "email", "status");

-- CreateIndex
CREATE INDEX "AcademyInvitation_email_status_idx" ON "AcademyInvitation"("email", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AcademyQrSession_tokenHash_key" ON "AcademyQrSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AcademyQrSession_academyId_expiresAt_idx" ON "AcademyQrSession"("academyId", "expiresAt");

-- CreateIndex
CREATE INDEX "AcademyQrSession_expiresAt_idx" ON "AcademyQrSession"("expiresAt");

-- CreateIndex
CREATE INDEX "AcademyCourse_academyId_status_deletedAt_idx" ON "AcademyCourse"("academyId", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "AcademyContent_courseId_status_deletedAt_displayOrder_idx" ON "AcademyContent"("courseId", "status", "deletedAt", "displayOrder");

-- CreateIndex
CREATE INDEX "BroadcastAcademyTarget_broadcastId_idx" ON "BroadcastAcademyTarget"("broadcastId");

-- CreateIndex
CREATE INDEX "BroadcastAcademyTarget_academyId_idx" ON "BroadcastAcademyTarget"("academyId");

-- CreateIndex
CREATE UNIQUE INDEX "BroadcastAcademyTarget_broadcastId_academyId_key" ON "BroadcastAcademyTarget"("broadcastId", "academyId");

-- AddForeignKey
ALTER TABLE "AcademyMembership" ADD CONSTRAINT "AcademyMembership_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyMembership" ADD CONSTRAINT "AcademyMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyInvitation" ADD CONSTRAINT "AcademyInvitation_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyInvitation" ADD CONSTRAINT "AcademyInvitation_invitedBy_fkey" FOREIGN KEY ("invitedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyQrSession" ADD CONSTRAINT "AcademyQrSession_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyQrSession" ADD CONSTRAINT "AcademyQrSession_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyCourse" ADD CONSTRAINT "AcademyCourse_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyContent" ADD CONSTRAINT "AcademyContent_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "AcademyCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastAcademyTarget" ADD CONSTRAINT "BroadcastAcademyTarget_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastAcademyTarget" ADD CONSTRAINT "BroadcastAcademyTarget_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraints
ALTER TABLE "Academy" ADD CONSTRAINT "Academy_counters_check" CHECK (
    "studentCount" >= 0 AND
    "activeStudentCount" >= 0 AND
    "courseCount" >= 0 AND
    "activeCourseCount" >= 0 AND
    "packageCount" >= 0 AND
    "orderCount" >= 0 AND
    "revenue" >= 0.00
);

