import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { generateMonthlyReportPdf } from "../services/monthlyReportPdfService.js";
import type { MonthlyReportSnapshot } from "../services/monthlyReportTypes.js";

const snapshot: MonthlyReportSnapshot = {
  schemaVersion: 2,
  algorithmVersion: "monthly-report-test-v1",
  generatedFor: { userId: "student-1", fullName: "Test Learner", courseId: "course-1", courseCode: "CA", courseName: "Chartered Accountancy", timezone: "Asia/Kolkata" },
  period: { yearMonth: "2026-07", label: "Jul 2026", previousYearMonth: "2026-06", previousLabel: "Jun 2026", start: "2026-07-01", endExclusive: "2026-08-01" },
  header: { studyStreakDays: 4, monthlyGoalPercent: 62, previousDataAvailable: true },
  summary: {
    mcqsAttempted: 20, mcqsCorrect: 14, accuracyPercent: 70, conceptsCompleted: 3, studyHours: 12.5, testsTaken: 2,
    deltas: {
      mcqsAttempted: { value: 5, unit: "COUNT", direction: "UP" }, mcqsCorrect: { value: 4, unit: "COUNT", direction: "UP" }, accuracyPercent: { value: 3, unit: "PERCENTAGE_POINTS", direction: "UP" },
      conceptsCompleted: { value: 1, unit: "COUNT", direction: "UP" }, studyHours: { value: 2.5, unit: "HOURS", direction: "UP" }, testsTaken: { value: 1, unit: "COUNT", direction: "UP" },
    },
  },
  monthlyTrend: [{ yearMonth: "2026-06", label: "Jun", attempted: 15, correct: 10, accuracyPercent: 66.7 }, { yearMonth: "2026-07", label: "Jul", attempted: 20, correct: 14, accuracyPercent: 70 }],
  weeklyAccuracy: [{ label: "W1", attempted: 5, accuracyPercent: 60 }, { label: "W2", attempted: 5, accuracyPercent: 80 }, { label: "W3", attempted: 5, accuracyPercent: 60 }, { label: "W4", attempted: 5, accuracyPercent: 80 }],
  subjectPerformance: [{ subjectId: "subject-1", name: "Accounting", attempted: 20, currentAccuracy: 70, previousAccuracy: 66.7, changePoints: 3.3 }],
  conceptCompletion: { completed: 3, inProgress: 4, notStarted: 5, total: 12 },
  strengths: [{ name: "Ledger entries", accuracyPercent: 90, attempted: 10 }], weakAreas: [{ name: "Cash flow", accuracyPercent: 40, attempted: 5 }],
  practiceDistribution: [{ label: "Easy", count: 8, percent: 40 }, { label: "Medium", count: 8, percent: 40 }, { label: "Hard", count: 4, percent: 20 }],
  consistency: Array.from({ length: 31 }, (_, index) => ({ date: `2026-07-${String(index + 1).padStart(2, "0")}`, weekday: index % 7 + 1, week: Math.floor(index / 7), studySeconds: index % 3 ? 1800 : 0, intensity: index % 3 ? 2 : 0 })),
  testPerformance: { available: true, testsTaken: 2, averageScore: 65, best: { title: "Mock 2", score: 75 }, lowest: { title: "Mock 1", score: 55 }, trend: [{ label: "T1", score: 55 }, { label: "T2", score: 75 }] },
  overallProgress: { syllabusPercent: 25, previousSyllabusPercent: 17, changePoints: 8, messageTitle: "A productive month, Test Learner.", messageBody: "Your stored activity shows steady progress. Keep practising the weaker concepts.", rank: null },
  audit: { sourceDataHash: "a".repeat(64), generatedAt: "2026-08-01T00:00:00.000Z" },
};

test("monthly report PDF is deterministic, valid and uses one unclipped report canvas", async () => {
  const first = await generateMonthlyReportPdf(snapshot);
  const second = await generateMonthlyReportPdf(snapshot);
  assert.equal(first.subarray(0, 5).toString(), "%PDF-");
  assert.equal(createHash("sha256").update(first).digest("hex"), createHash("sha256").update(second).digest("hex"));
  const pdf = await PDFDocument.load(first);
  assert.equal(pdf.getPageCount(), 1);
  const size = pdf.getPage(0).getSize();
  assert.deepEqual(size, { width: 1024, height: 1536 });
  assert.ok(first.length > 5_000);
});
