import assert from "node:assert/strict";
import test from "node:test";
import { earliestExpiry, normalizeAccessDurationPolicy, resolveEntitlementExpiry } from "../services/resourceValidityService.js";

test("access is permanent by default and free resources cannot carry a fixed duration", () => {
  assert.deepEqual(normalizeAccessDurationPolicy({ accessType: "PAID" }), { accessType: "PAID", accessDurationValue: null, accessDurationUnit: null });
  assert.deepEqual(normalizeAccessDurationPolicy({ accessType: "FREE", accessDurationValue: 30, accessDurationUnit: "DAYS" }), { accessType: "FREE", accessDurationValue: null, accessDurationUnit: null });
  assert.equal(resolveEntitlementExpiry({ accessDurationValue: null, accessDurationUnit: null }, new Date("2027-09-14T00:00:00.000Z")), null);
});

test("fixed durations start at purchase or activation time", () => {
  const startsAt = new Date("2027-01-01T10:15:00.000Z");
  assert.equal(resolveEntitlementExpiry({ accessDurationValue: 10, accessDurationUnit: "DAYS" }, startsAt)?.toISOString(), "2027-01-11T10:15:00.000Z");
  assert.equal(resolveEntitlementExpiry({ accessDurationValue: 2, accessDurationUnit: "WEEKS" }, startsAt)?.toISOString(), "2027-01-15T10:15:00.000Z");
  assert.equal(resolveEntitlementExpiry({ accessDurationValue: 1, accessDurationUnit: "MONTHS" }, new Date("2027-01-31T10:15:00.000Z"))?.toISOString(), "2027-02-28T10:15:00.000Z");
});

test("the earlier entitlement expiry always wins", () => {
  const first = new Date("2027-09-20T00:00:00.000Z");
  const second = new Date("2027-10-15T00:00:00.000Z");
  assert.equal(earliestExpiry(first, second)?.toISOString(), first.toISOString());
  assert.equal(earliestExpiry(null, second)?.toISOString(), second.toISOString());
  assert.equal(earliestExpiry(null, undefined), null);
});

test("invalid, incomplete and excessive fixed durations fail closed", () => {
  const invalid = [
    { accessDurationValue: 0, accessDurationUnit: "DAYS" as const },
    { accessDurationValue: 1.5, accessDurationUnit: "DAYS" as const },
    { accessDurationValue: 3651, accessDurationUnit: "DAYS" as const },
    { accessDurationValue: 521, accessDurationUnit: "WEEKS" as const },
    { accessDurationValue: 121, accessDurationUnit: "MONTHS" as const },
    { accessDurationValue: 10, accessDurationUnit: null },
  ];
  for (const policy of invalid) {
    assert.throws(() => normalizeAccessDurationPolicy({ accessType: "PAID", ...policy }), /fixed access|duration/i);
  }
});
