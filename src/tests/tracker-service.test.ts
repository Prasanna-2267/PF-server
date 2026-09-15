import assert from "node:assert/strict";
import { test } from "node:test";
import { revisionIntervalDays } from "../services/trackerService.js";

test("revision rhythm expands the return interval by revision depth", () => {
  assert.equal(revisionIntervalDays(0), null);
  assert.equal(revisionIntervalDays(1), 1);
  assert.equal(revisionIntervalDays(2), 7);
  assert.equal(revisionIntervalDays(3), 21);
  assert.equal(revisionIntervalDays(12), 21);
});
