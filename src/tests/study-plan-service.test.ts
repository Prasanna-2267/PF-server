import assert from "node:assert/strict";
import { test } from "node:test";
import { packStudyCandidates } from "../services/studyPlanService.js";

const candidate = (title: string, priority: number, contentItemId: string | null, estimatedMinutes = 45) => ({ type: "READ_NOTE" as const, source: "SYLLABUS_PLAN" as const, title, reason: "test", contentItemId, estimatedMinutes, priority });

test("study-plan packing respects priority, daily capacity, session bounds and content deduplication", () => {
  const packed = packStudyCandidates([
    candidate("Lower", 10, "a"),
    candidate("Due", 90, "b", 25),
    candidate("Duplicate", 80, "b", 30),
    candidate("Continue", 70, "c", 40),
  ], 60);
  assert.deepEqual(packed.map((task) => task.title), ["Due", "Continue"]);
  assert.deepEqual(packed.map((task) => task.plannedMinutes), [25, 35]);
  assert.equal(packed.reduce((sum, task) => sum + task.plannedMinutes, 0), 60);
});

test("study-plan packing preserves capacity already occupied by manual work", () => {
  const packed = packStudyCandidates([candidate("Generated", 50, "a")], 60, 50, 1);
  assert.equal(packed.length, 0);
});
