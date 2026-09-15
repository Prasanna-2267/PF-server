CREATE TYPE "ExamDatePrecision" AS ENUM ('DAY', 'MONTH');

CREATE TABLE "LearnerPreference" (
    "userId" UUID NOT NULL,
    "selectedCourseId" UUID,
    "examDate" TIMESTAMP(3),
    "examDatePrecision" "ExamDatePrecision",
    "academyReference" TEXT,
    "dailyTargetMinutes" INTEGER NOT NULL DEFAULT 120,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "language" TEXT NOT NULL DEFAULT 'English',
    "reminderTime" TEXT NOT NULL DEFAULT '19:00',
    "onboardingCompletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearnerPreference_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX "LearnerPreference_selectedCourseId_idx" ON "LearnerPreference"("selectedCourseId");

ALTER TABLE "LearnerPreference"
ADD CONSTRAINT "LearnerPreference_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LearnerPreference"
ADD CONSTRAINT "LearnerPreference_selectedCourseId_fkey"
FOREIGN KEY ("selectedCourseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;
