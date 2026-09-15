CREATE TABLE "LearnerMonthlyReport" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "yearMonth" VARCHAR(7) NOT NULL,
    "timezone" VARCHAR(80) NOT NULL,
    "courseCodeSnapshot" VARCHAR(80) NOT NULL,
    "courseNameSnapshot" VARCHAR(180) NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEndExclusive" DATE NOT NULL,
    "totalStudySeconds" INTEGER NOT NULL,
    "focusSeconds" INTEGER NOT NULL,
    "readingSeconds" INTEGER NOT NULL,
    "practiceSeconds" INTEGER NOT NULL,
    "revisionSeconds" INTEGER NOT NULL,
    "activeDays" INTEGER NOT NULL,
    "goalDays" INTEGER NOT NULL,
    "streakDays" INTEGER NOT NULL,
    "protectedDays" INTEGER NOT NULL,
    "notesCompleted" INTEGER NOT NULL,
    "revisionsCompleted" INTEGER NOT NULL,
    "studyTasksCompleted" INTEGER NOT NULL,
    "totalNotes" INTEGER NOT NULL,
    "syllabusCompleted" INTEGER NOT NULL,
    "syllabusPercent" INTEGER NOT NULL,
    "weeklyStudySeconds" JSONB NOT NULL,
    "algorithmVersion" VARCHAR(80) NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearnerMonthlyReport_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LearnerMonthlyReport_non_negative_check" CHECK (
      "totalStudySeconds" >= 0 AND "focusSeconds" >= 0 AND "readingSeconds" >= 0
      AND "practiceSeconds" >= 0 AND "revisionSeconds" >= 0 AND "activeDays" >= 0
      AND "goalDays" >= 0 AND "streakDays" >= 0 AND "protectedDays" >= 0
      AND "notesCompleted" >= 0 AND "revisionsCompleted" >= 0
      AND "studyTasksCompleted" >= 0 AND "totalNotes" >= 0
      AND "syllabusCompleted" >= 0 AND "syllabusPercent" BETWEEN 0 AND 100
    )
);

CREATE UNIQUE INDEX "LearnerMonthlyReport_userId_yearMonth_key" ON "LearnerMonthlyReport"("userId", "yearMonth");
CREATE INDEX "LearnerMonthlyReport_userId_periodStart_idx" ON "LearnerMonthlyReport"("userId", "periodStart");
CREATE INDEX "LearnerMonthlyReport_courseId_periodStart_idx" ON "LearnerMonthlyReport"("courseId", "periodStart");

ALTER TABLE "LearnerMonthlyReport" ADD CONSTRAINT "LearnerMonthlyReport_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearnerMonthlyReport" ADD CONSTRAINT "LearnerMonthlyReport_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
