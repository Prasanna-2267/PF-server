import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { prisma } from "../db/prisma.js";
import { databaseDate, learnerDateKey } from "../services/learnerTime.js";
import * as tracker from "../services/trackerService.js";
import { integrationDatabaseEnabled } from "../tests/integration-database-guard.js";

const enabled = integrationDatabaseEnabled("RUN_BACKEND_INTEGRATION");
const suffix = randomUUID().slice(0, 8);
let userId = "";
let courseId = "";
let subjectId = "";
let chapterId = "";
let noteId = "";

before(async () => {
  if (!enabled) return;
  const role = await prisma.role.upsert({ where: { key: "student" }, create: { key: "student", name: "Student", description: "Learner role" }, update: {}, select: { id: true } });
  userId = randomUUID();
  courseId = randomUUID();
  subjectId = randomUUID();
  chapterId = randomUUID();
  noteId = randomUUID();
  await prisma.user.create({ data: { id: userId, email: `tracker-${suffix}@test.local`, fullName: "Tracker Learner", roleId: role.id } });
  await prisma.course.create({ data: { id: courseId, slug: `tracker-${suffix}`, code: `T${suffix.slice(0, 6)}`, name: "Tracker Course" } });
  await prisma.contentItem.create({ data: { id: subjectId, courseId, kind: "FOLDER", name: "Physics", entityType: "SUBJECT" } });
  await prisma.contentItem.create({ data: { id: chapterId, courseId, parentId: subjectId, kind: "FOLDER", name: "Motion", entityType: "CHAPTER" } });
  await prisma.contentItem.create({ data: { id: noteId, courseId, parentId: chapterId, kind: "FILE", name: "Motion Notes", mimeType: "application/pdf" } });
  await prisma.learnerPreference.create({ data: { userId, selectedCourseId: courseId, timezone: "UTC", dailyTargetMinutes: 60, examDate: new Date(Date.now() + 30 * 86_400_000), examDatePrecision: "DAY" } });
  await prisma.learnerNoteState.create({ data: { userId, contentItemId: noteId, completed: true, completedAt: new Date(), revisionCount: 1 } });
  await prisma.noteRevisionEvent.create({ data: { userId, contentItemId: noteId, source: "MANUAL", revisedAt: new Date(Date.now() - 2 * 86_400_000) } });
  await prisma.learnerDailyActivity.create({ data: { userId, localDate: databaseDate(learnerDateKey(new Date(), "UTC")), timezone: "UTC", targetMinutes: 60, focusSeconds: 3600, focusSessionCount: 1, qualifiesStreak: true, goalCompleted: true, lastActivityAt: new Date() } });
});

after(async () => {
  if (!enabled) return;
  await prisma.user.delete({ where: { id: userId } });
  await prisma.contentItem.delete({ where: { id: noteId } });
  await prisma.contentItem.delete({ where: { id: chapterId } });
  await prisma.contentItem.delete({ where: { id: subjectId } });
  await prisma.course.delete({ where: { id: courseId } });
  await prisma.$disconnect();
});

test("tracker aggregates activity and chapter revision rhythm from learner records", { skip: !enabled }, async () => {
  const summary = await tracker.getTrackerSummary(userId, 7);
  assert.equal(summary.summary.goalDays, 1);
  assert.equal(summary.summary.totalSeconds, 3600);
  assert.equal(summary.readiness.syllabusPercent, 100);
  assert.equal(summary.readiness.revisions, 1);

  const revisions = await tracker.getRevisionChapters(userId, { filter: "all" });
  assert.equal(revisions.summary.totalChapters, 1);
  assert.equal(revisions.chapters[0]?.subject.title, "Physics");
  assert.equal(revisions.chapters[0]?.title, "Motion");
  assert.equal(revisions.chapters[0]?.status, "due");

  const history = await tracker.getRevisionHistory(userId, { page: 1, limit: 10 });
  assert.equal(history.pagination.total, 1);
  assert.equal(history.items[0]?.noteTitle, "Motion Notes");
});
