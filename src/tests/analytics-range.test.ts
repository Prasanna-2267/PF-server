import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnalyticsDateRange } from "../services/academyAnalyticsService.js";

test("analytics rejects unknown and oversized custom ranges", () => {
  assert.throws(() => parseAnalyticsDateRange({ rangeType: "FOREVER" }), /Invalid analytics rangeType/);
  assert.throws(() => parseAnalyticsDateRange({ rangeType: "CUSTOM", startDate: "2024-01-01T00:00:00.000Z", endDate: "2025-01-02T00:00:00.000Z" }), /cannot exceed 365 days/);
});

test("TODAY begins at midnight UTC", () => {
  const range = parseAnalyticsDateRange({ rangeType: "TODAY" });
  assert.equal(range.startDate.getUTCHours(), 0);
  assert.equal(range.startDate.getUTCMinutes(), 0);
});
