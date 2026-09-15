import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { prisma } from "../db/prisma.js";
import { learnerDateKey } from "../services/learnerTime.js";
import * as studyPlan from "../services/studyPlanService.js";
import { integrationDatabaseEnabled } from "../tests/integration-database-guard.js";

const enabled = integrationDatabaseEnabled("RUN_BACKEND_INTEGRATION");
const suffix = randomUUID().slice(0, 8);
let userId = "";
let courseId = "";
let noteA = "";
let noteB = "";

before(async () => {
  if (!enabled) return;
  const role = await prisma.role.upsert({ where: { key: "student" }, create: { key: "student", name: "Student", description: "Learner role" }, update: {}, select: { id: true } });
  userId = randomUUID(); courseId = randomUUID(); noteA = randomUUID(); noteB = randomUUID();
  await prisma.user.create({ data: { id: userId, email: `plan-${suffix}@test.local`, fullName: "Plan Learner", roleId: role.id } });
  await prisma.course.create({ data: { id: courseId, slug: `plan-${suffix}`, code: `P${suffix.slice(0, 6)}`, name: `Plan Course ${suffix}` } });
  await prisma.contentItem.createMany({ data: [
    { id: noteA, courseId, kind: "FILE", name: "First Note", mimeType: "application/pdf", storagePath: `integration/study-plan/${noteA}.pdf`, displayOrder: 1 },
    { id: noteB, courseId, kind: "FILE", name: "Second Note", mimeType: "application/pdf", storagePath: `integration/study-plan/${noteB}.pdf`, displayOrder: 2 },
  ] });
  await prisma.learnerPreference.create({ data: { userId, selectedCourseId: courseId, timezone: "UTC", dailyTargetMinutes: 60, examDate: new Date(Date.now() + 60 * 86_400_000), examDatePrecision: "DAY" } });
  await prisma.studyWorkloadEstimate.create({ data: { contentItemId: noteA, estimatedReadingMinutes: 50, estimatedRevisionMinutes: 20 } });
  await prisma.learnerNoteState.create({ data: { userId, contentItemId: noteA, progressPercent: 35 } });
});

after(async () => {
  if (!enabled) return;
  await prisma.user.delete({ where: { id: userId } });
  await prisma.contentItem.deleteMany({ where: { id: { in: [noteA, noteB] } } });
  await prisma.course.delete({ where: { id: courseId } });
  await prisma.$disconnect();
});

test("daily study plan is stable, capacity-bound and preserves completed history", { skip: !enabled }, async () => {
  const date = learnerDateKey(new Date(), "UTC");
  const first = await studyPlan.getTodayStudyPlan(userId, date);
  assert.equal(first.localDate, date);
  assert.ok(first.tasks.length > 0);
  assert.ok(first.summary.plannedMinutes <= 60);
  assert.equal(first.tasks[0]?.type, "CONTINUE_NOTE");
  assert.equal(first.tasks[0]?.estimateSource, "ADMIN");

  const stable = await studyPlan.getTodayStudyPlan(userId, date);
  assert.deepEqual(stable.tasks.map((task) => task.id), first.tasks.map((task) => task.id));

  const completed = await studyPlan.updateStudyTask(userId, first.tasks[0]!.id, { action: "complete", actualMinutes: 20 });
  assert.equal(completed.tasks.find((task) => task.id === first.tasks[0]!.id)?.status, "COMPLETED");
  const replay = await studyPlan.updateStudyTask(userId, first.tasks[0]!.id, { action: "complete", actualMinutes: 40 });
  assert.equal(replay.tasks.find((task) => task.id === first.tasks[0]!.id)?.actualMinutes, 20);

  const manual = await studyPlan.addManualTask(userId, { title: "My own task", plannedMinutes: 15, date });
  assert.equal(manual.tasks.some((task) => task.title === "My own task" && task.source === "MANUAL"), true);
  const cleared = await studyPlan.clearCompletedTasks(userId, date);
  assert.equal(cleared.tasks.some((task) => task.id === first.tasks[0]!.id), false);
  assert.equal(await prisma.learnerStudyTask.count({ where: { id: first.tasks[0]!.id, status: "COMPLETED" } }), 1);
});
