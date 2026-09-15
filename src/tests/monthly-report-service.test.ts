import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseDate } from "../services/learnerTime.js";
import { monthlyReportSchedule, summarizeMonthlyActivity } from "../services/monthlyReportService.js";
import { calculateExamCountdown } from "../services/trackerService.js";

test("monthly report combines persisted activity and groups it into calendar weeks", () => {
  const report = summarizeMonthlyActivity([
    { localDate: databaseDate("2026-08-02"), focusSeconds: 1800, readingSeconds: 600, practiceSeconds: 0, revisionSeconds: 0, goalCompleted: false },
    { localDate: databaseDate("2026-08-08"), focusSeconds: 1200, readingSeconds: 0, practiceSeconds: 300, revisionSeconds: 300, goalCompleted: true },
    { localDate: databaseDate("2026-08-31"), focusSeconds: 900, readingSeconds: 0, practiceSeconds: 0, revisionSeconds: 300, goalCompleted: true },
  ]);
  assert.equal(report.totalStudySeconds, 5400);
  assert.equal(report.activeDays, 3);
  assert.equal(report.goalDays, 2);
  assert.deepEqual(report.weeklyStudySeconds, [2400, 1800, 0, 0, 1200]);
});

test("monthly report does not count an empty persisted activity row as active", () => {
  const report = summarizeMonthlyActivity([
    { localDate: databaseDate("2026-08-12"), focusSeconds: 0, readingSeconds: 0, practiceSeconds: 0, revisionSeconds: 0, goalCompleted: false },
  ]);
  assert.equal(report.activeDays, 0);
  assert.equal(report.totalStudySeconds, 0);
});

test("monthly report scheduling uses the purchase calendar month in the learner timezone", () => {
  const ordinary = monthlyReportSchedule(new Date("2025-05-21T12:00:00.000Z"), "Asia/Kolkata");
  assert.equal(ordinary.yearMonth, "2025-05");
  assert.equal(ordinary.start.toISOString(), "2025-05-01T00:00:00.000Z");
  assert.equal(ordinary.end.toISOString(), "2025-06-01T00:00:00.000Z");
  assert.equal(ordinary.runAt.toISOString(), "2025-05-31T18:30:00.000Z");

  const lastSecond = monthlyReportSchedule(new Date("2025-05-31T18:29:59.000Z"), "Asia/Kolkata");
  assert.equal(lastSecond.yearMonth, "2025-05");
  assert.equal(lastSecond.runAt.toISOString(), "2025-05-31T18:30:00.000Z");

  const nextMonth = monthlyReportSchedule(new Date("2025-05-31T18:30:00.000Z"), "Asia/Kolkata");
  assert.equal(nextMonth.yearMonth, "2025-06");
  assert.equal(nextMonth.runAt.toISOString(), "2025-06-30T18:30:00.000Z");
});

test("monthly report month-end scheduling handles daylight-saving timezones", () => {
  const schedule = monthlyReportSchedule(new Date("2025-06-12T16:00:00.000Z"), "America/New_York");
  assert.equal(schedule.yearMonth, "2025-06");
  assert.equal(schedule.runAt.toISOString(), "2025-07-01T04:00:00.000Z");
});

test("exam countdown preserves the selected calendar date and clamps completed exams", () => {
  assert.deepEqual(calculateExamCountdown(new Date("2027-02-01T00:00:00.000Z"), "2026-09-14"), {
    dateKey: "2027-02-01",
    daysRemaining: 140,
    pressurePercent: 62,
  });
  assert.deepEqual(calculateExamCountdown(new Date("2026-09-14T00:00:00.000Z"), "2026-09-14"), {
    dateKey: "2026-09-14",
    daysRemaining: 0,
    pressurePercent: 100,
  });
  assert.deepEqual(calculateExamCountdown(new Date("2026-09-01T00:00:00.000Z"), "2026-09-14"), {
    dateKey: "2026-09-01",
    daysRemaining: 0,
    pressurePercent: 100,
  });
});
