-- AlterTable: Add academyId to Course, Question, Broadcast
ALTER TABLE "Course" ADD COLUMN "academyId" UUID;
ALTER TABLE "Question" ADD COLUMN "academyId" UUID;
ALTER TABLE "Broadcast" ADD COLUMN "academyId" UUID;

-- CreateEnum: EnrollmentStatus
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateTable: AcademyCourseEnrollment
CREATE TABLE "AcademyCourseEnrollment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "academyId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademyCourseEnrollment_pkey" PRIMARY KEY ("id")
);

-- Course Code Uniqueness: Replace global Course_code_key with tenant-scoped Course_academyId_code_key
DROP INDEX IF EXISTS "Course_code_key";
CREATE UNIQUE INDEX "Course_academyId_code_key" ON "Course"("academyId", "code");

-- CreateIndexes & Unique Constraints
CREATE UNIQUE INDEX "AcademyCourseEnrollment_studentId_courseId_key" ON "AcademyCourseEnrollment"("studentId", "courseId");
CREATE INDEX "AcademyCourseEnrollment_academyId_status_idx" ON "AcademyCourseEnrollment"("academyId", "status");
CREATE INDEX "AcademyCourseEnrollment_studentId_status_idx" ON "AcademyCourseEnrollment"("studentId", "status");
CREATE INDEX "AcademyCourseEnrollment_courseId_idx" ON "AcademyCourseEnrollment"("courseId");

CREATE INDEX "Course_academyId_status_deletedAt_idx" ON "Course"("academyId", "status", "deletedAt");
CREATE INDEX "Question_academyId_status_deletedAt_idx" ON "Question"("academyId", "status", "deletedAt");
CREATE INDEX "Broadcast_academyId_status_deletedAt_idx" ON "Broadcast"("academyId", "status", "deletedAt");

-- Foreign Keys (Data Safety: ON DELETE SET NULL for primary resources, ON DELETE RESTRICT for enrollments)
ALTER TABLE "Course" ADD CONSTRAINT "Course_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Question" ADD CONSTRAINT "Question_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AcademyCourseEnrollment" ADD CONSTRAINT "AcademyCourseEnrollment_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AcademyCourseEnrollment" ADD CONSTRAINT "AcademyCourseEnrollment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AcademyCourseEnrollment" ADD CONSTRAINT "AcademyCourseEnrollment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
