-- CreateEnum
CREATE TYPE "QuestionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "QuestionDifficulty" AS ENUM ('FOUNDATION', 'INTERMEDIATE', 'ADVANCED');

-- CreateEnum
CREATE TYPE "QuestionKind" AS ENUM ('NORMAL_MCQ', 'NORMAL_DESCRIPTIVE', 'CASE_MCQ', 'CASE_DESCRIPTIVE');

-- CreateEnum
CREATE TYPE "CaseClassificationMode" AS ENUM ('ENTIRE_CASE', 'INDIVIDUAL_SUB_QUESTIONS');

-- CreateTable
CREATE TABLE "TaxonomyChapter" (
    "id" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxonomyChapter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxonomyLesson" (
    "id" UUID NOT NULL,
    "chapterId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxonomyLesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxonomyTopic" (
    "id" UUID NOT NULL,
    "lessonId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxonomyTopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" UUID NOT NULL,
    "kind" "QuestionKind" NOT NULL,
    "status" "QuestionStatus" NOT NULL DEFAULT 'DRAFT',
    "difficulty" "QuestionDifficulty" NOT NULL DEFAULT 'INTERMEDIATE',
    "questionHtml" TEXT NOT NULL DEFAULT '',
    "answerHtml" TEXT NOT NULL DEFAULT '',
    "correctOptionId" VARCHAR(1),
    "correctExplanationHtml" TEXT NOT NULL DEFAULT '',
    "premiumWrongOptionsExplanationHtml" TEXT NOT NULL DEFAULT '',
    "caseHtml" TEXT NOT NULL DEFAULT '',
    "caseId" TEXT,
    "classificationMode" "CaseClassificationMode" NOT NULL DEFAULT 'ENTIRE_CASE',
    "courseId" UUID,
    "subjectId" UUID,
    "chapterId" UUID,
    "lessonId" UUID,
    "topicId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionOption" (
    "id" UUID NOT NULL,
    "questionId" UUID,
    "subQuestionId" UUID,
    "optionLabel" VARCHAR(1) NOT NULL,
    "html" TEXT NOT NULL DEFAULT '',
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QuestionOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseSubQuestion" (
    "id" UUID NOT NULL,
    "questionId" UUID NOT NULL,
    "questionHtml" TEXT NOT NULL DEFAULT '',
    "correctOptionId" VARCHAR(1),
    "correctExplanationHtml" TEXT NOT NULL DEFAULT '',
    "premiumWrongOptionsExplanationHtml" TEXT NOT NULL DEFAULT '',
    "answerHtml" TEXT NOT NULL DEFAULT '',
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "courseId" UUID,
    "subjectId" UUID,
    "chapterId" UUID,
    "lessonId" UUID,
    "topicId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseSubQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxonomyChapter_subjectId_idx" ON "TaxonomyChapter"("subjectId");

-- CreateIndex
CREATE INDEX "TaxonomyChapter_courseId_idx" ON "TaxonomyChapter"("courseId");

-- CreateIndex
CREATE INDEX "TaxonomyLesson_chapterId_idx" ON "TaxonomyLesson"("chapterId");

-- CreateIndex
CREATE INDEX "TaxonomyTopic_lessonId_idx" ON "TaxonomyTopic"("lessonId");

-- CreateIndex
CREATE INDEX "Question_courseId_subjectId_chapterId_lessonId_topicId_idx" ON "Question"("courseId", "subjectId", "chapterId", "lessonId", "topicId");

-- CreateIndex
CREATE INDEX "Question_kind_status_difficulty_deletedAt_idx" ON "Question"("kind", "status", "difficulty", "deletedAt");

-- CreateIndex
CREATE INDEX "Question_caseId_idx" ON "Question"("caseId");

-- CreateIndex
CREATE INDEX "Question_createdAt_idx" ON "Question"("createdAt");

-- CreateIndex
CREATE INDEX "QuestionOption_questionId_idx" ON "QuestionOption"("questionId");

-- CreateIndex
CREATE INDEX "QuestionOption_subQuestionId_idx" ON "QuestionOption"("subQuestionId");

-- CreateIndex
CREATE INDEX "CaseSubQuestion_questionId_displayOrder_idx" ON "CaseSubQuestion"("questionId", "displayOrder");

-- CreateIndex
CREATE INDEX "ContentSampleImage_contentId_displayOrder_idx" ON "ContentSampleImage"("contentId", "displayOrder");

-- CreateIndex
CREATE INDEX "ContentStoreSection_contentId_displayOrder_idx" ON "ContentStoreSection"("contentId", "displayOrder");

-- AddForeignKey
ALTER TABLE "TaxonomyChapter" ADD CONSTRAINT "TaxonomyChapter_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxonomyChapter" ADD CONSTRAINT "TaxonomyChapter_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxonomyLesson" ADD CONSTRAINT "TaxonomyLesson_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "TaxonomyChapter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxonomyTopic" ADD CONSTRAINT "TaxonomyTopic_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "TaxonomyLesson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "TaxonomyChapter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "TaxonomyLesson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "TaxonomyTopic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionOption" ADD CONSTRAINT "QuestionOption_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionOption" ADD CONSTRAINT "QuestionOption_subQuestionId_fkey" FOREIGN KEY ("subQuestionId") REFERENCES "CaseSubQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseSubQuestion" ADD CONSTRAINT "CaseSubQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseSubQuestion" ADD CONSTRAINT "CaseSubQuestion_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseSubQuestion" ADD CONSTRAINT "CaseSubQuestion_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseSubQuestion" ADD CONSTRAINT "CaseSubQuestion_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "TaxonomyChapter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseSubQuestion" ADD CONSTRAINT "CaseSubQuestion_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "TaxonomyLesson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseSubQuestion" ADD CONSTRAINT "CaseSubQuestion_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "TaxonomyTopic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Custom Partial Unique Indexes for Taxonomy Case-Insensitive Name Uniqueness
CREATE UNIQUE INDEX "TaxonomyChapter_subjectId_name_ci_key"
ON "TaxonomyChapter" ("subjectId", LOWER(BTRIM("name")));

CREATE UNIQUE INDEX "TaxonomyLesson_chapterId_name_ci_key"
ON "TaxonomyLesson" ("chapterId", LOWER(BTRIM("name")));

CREATE UNIQUE INDEX "TaxonomyTopic_lessonId_name_ci_key"
ON "TaxonomyTopic" ("lessonId", LOWER(BTRIM("name")));

-- Custom Partial Unique Indexes for QuestionOption Option Label Uniqueness
CREATE UNIQUE INDEX "QuestionOption_questionId_optionLabel_key"
ON "QuestionOption" ("questionId", "optionLabel")
WHERE "questionId" IS NOT NULL;

CREATE UNIQUE INDEX "QuestionOption_subQuestionId_optionLabel_key"
ON "QuestionOption" ("subQuestionId", "optionLabel")
WHERE "subQuestionId" IS NOT NULL;

