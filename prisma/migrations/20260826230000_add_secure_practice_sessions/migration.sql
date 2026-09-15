CREATE TYPE "PracticeCollection" AS ENUM ('PYQ', 'RTP', 'MTP', 'ORIGINAL');
CREATE TYPE "PracticeSourceKind" AS ENUM ('ARCHIVE');
CREATE TYPE "PracticeAnswerFormat" AS ENUM ('MCQ', 'DESCRIPTIVE', 'CASE_STUDY');
CREATE TYPE "PracticeAccessPolicy" AS ENUM ('FREE', 'PAID');
CREATE TYPE "PracticeSessionStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'EXPIRED', 'ABANDONED');
CREATE TYPE "PracticeNavigatorState" AS ENUM ('UNANSWERED', 'ANSWERED_CORRECT', 'ANSWERED_WRONG', 'MARKED_REVIEW', 'LOCKED_WRONG', 'AWAITING_REVIEW');

ALTER TABLE "Question"
ADD COLUMN "practiceCollection" "PracticeCollection" NOT NULL DEFAULT 'ORIGINAL',
ADD COLUMN "practiceYear" INTEGER;

ALTER TABLE "Question"
ADD CONSTRAINT "Question_practiceYear_range_check" CHECK ("practiceYear" IS NULL OR "practiceYear" BETWEEN 1900 AND 2100);

CREATE TABLE "PracticeSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "sourceKind" "PracticeSourceKind" NOT NULL,
    "subjectId" UUID,
    "chapterId" UUID,
    "lessonId" UUID,
    "topicId" UUID,
    "collection" "PracticeCollection",
    "year" INTEGER,
    "answerFormat" "PracticeAnswerFormat" NOT NULL,
    "accessPolicy" "PracticeAccessPolicy" NOT NULL,
    "timerSeconds" INTEGER,
    "questionCount" INTEGER NOT NULL,
    "answeredCount" INTEGER NOT NULL DEFAULT 0,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "wrongCount" INTEGER NOT NULL DEFAULT 0,
    "markedReviewCount" INTEGER NOT NULL DEFAULT 0,
    "status" "PracticeSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeSession_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PracticeSession_questionCount_check" CHECK ("questionCount" > 0),
    CONSTRAINT "PracticeSession_counts_check" CHECK ("answeredCount" >= 0 AND "correctCount" >= 0 AND "wrongCount" >= 0 AND "markedReviewCount" >= 0),
    CONSTRAINT "PracticeSession_timerSeconds_check" CHECK ("timerSeconds" IS NULL OR "timerSeconds" BETWEEN 30 AND 86400),
    CONSTRAINT "PracticeSession_year_check" CHECK ("year" IS NULL OR "year" BETWEEN 1900 AND 2100)
);

CREATE TABLE "PracticeSessionQuestion" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "questionId" UUID NOT NULL,
    "subQuestionId" UUID,
    "sequence" INTEGER NOT NULL,
    "kind" "QuestionKind" NOT NULL,
    "difficulty" "QuestionDifficulty" NOT NULL,
    "promptHtml" TEXT NOT NULL,
    "caseHtml" TEXT NOT NULL DEFAULT '',
    "optionsSnapshot" JSONB NOT NULL,
    "correctOptionLabel" VARCHAR(1),
    "answerHtml" TEXT NOT NULL DEFAULT '',
    "correctExplanationHtml" TEXT NOT NULL DEFAULT '',
    "premiumWrongExplanationHtml" TEXT NOT NULL DEFAULT '',
    "subjectId" UUID,
    "chapterId" UUID,
    "lessonId" UUID,
    "topicId" UUID,
    "navigatorState" "PracticeNavigatorState" NOT NULL DEFAULT 'UNANSWERED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "final" BOOLEAN NOT NULL DEFAULT false,
    "lastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeSessionQuestion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PracticeSessionQuestion_sequence_check" CHECK ("sequence" > 0),
    CONSTRAINT "PracticeSessionQuestion_attemptCount_check" CHECK ("attemptCount" >= 0)
);

CREATE TABLE "PracticeAttempt" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sessionQuestionId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "clientAttemptId" VARCHAR(100) NOT NULL,
    "answerOptionLabel" VARCHAR(1),
    "answerText" TEXT,
    "correct" BOOLEAN,
    "durationMs" INTEGER,
    "explanationReleased" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PracticeAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PracticeAttempt_attemptNumber_check" CHECK ("attemptNumber" > 0),
    CONSTRAINT "PracticeAttempt_durationMs_check" CHECK ("durationMs" IS NULL OR "durationMs" >= 0),
    CONSTRAINT "PracticeAttempt_answer_check" CHECK ("answerOptionLabel" IS NOT NULL OR NULLIF(BTRIM("answerText"), '') IS NOT NULL)
);

CREATE INDEX "Question_courseId_practiceCollection_practiceYear_status_idx" ON "Question"("courseId", "practiceCollection", "practiceYear", "status");
CREATE INDEX "PracticeSession_userId_status_startedAt_idx" ON "PracticeSession"("userId", "status", "startedAt");
CREATE INDEX "PracticeSession_courseId_subjectId_chapterId_startedAt_idx" ON "PracticeSession"("courseId", "subjectId", "chapterId", "startedAt");
CREATE INDEX "PracticeSession_expiresAt_status_idx" ON "PracticeSession"("expiresAt", "status");
CREATE UNIQUE INDEX "PracticeSessionQuestion_sessionId_sequence_key" ON "PracticeSessionQuestion"("sessionId", "sequence");
CREATE INDEX "PracticeSessionQuestion_sessionId_navigatorState_sequence_idx" ON "PracticeSessionQuestion"("sessionId", "navigatorState", "sequence");
CREATE INDEX "PracticeSessionQuestion_questionId_idx" ON "PracticeSessionQuestion"("questionId");
CREATE INDEX "PracticeSessionQuestion_subQuestionId_idx" ON "PracticeSessionQuestion"("subQuestionId");
CREATE INDEX "PracticeSessionQuestion_chapterId_topicId_idx" ON "PracticeSessionQuestion"("chapterId", "topicId");
CREATE UNIQUE INDEX "PracticeAttempt_sessionQuestionId_attemptNumber_key" ON "PracticeAttempt"("sessionQuestionId", "attemptNumber");
CREATE UNIQUE INDEX "PracticeAttempt_sessionQuestionId_clientAttemptId_key" ON "PracticeAttempt"("sessionQuestionId", "clientAttemptId");
CREATE INDEX "PracticeAttempt_userId_createdAt_idx" ON "PracticeAttempt"("userId", "createdAt");
CREATE INDEX "PracticeAttempt_sessionQuestionId_createdAt_idx" ON "PracticeAttempt"("sessionQuestionId", "createdAt");

ALTER TABLE "PracticeSession" ADD CONSTRAINT "PracticeSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PracticeSession" ADD CONSTRAINT "PracticeSession_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PracticeSession" ADD CONSTRAINT "PracticeSession_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PracticeSession" ADD CONSTRAINT "PracticeSession_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "TaxonomyChapter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PracticeSession" ADD CONSTRAINT "PracticeSession_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "TaxonomyLesson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PracticeSession" ADD CONSTRAINT "PracticeSession_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "TaxonomyTopic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PracticeSessionQuestion" ADD CONSTRAINT "PracticeSessionQuestion_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PracticeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PracticeSessionQuestion" ADD CONSTRAINT "PracticeSessionQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PracticeSessionQuestion" ADD CONSTRAINT "PracticeSessionQuestion_subQuestionId_fkey" FOREIGN KEY ("subQuestionId") REFERENCES "CaseSubQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PracticeAttempt" ADD CONSTRAINT "PracticeAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PracticeAttempt" ADD CONSTRAINT "PracticeAttempt_sessionQuestionId_fkey" FOREIGN KEY ("sessionQuestionId") REFERENCES "PracticeSessionQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
