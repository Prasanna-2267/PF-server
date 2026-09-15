import type { AccessDurationUnit, ContentAccessType } from "../../generated/prisma/client.js";
import { badRequest } from "../errors/api-error.js";

export const ACCESS_DURATION_LIMITS: Record<AccessDurationUnit, number> = {
  DAYS: 3650,
  WEEKS: 520,
  MONTHS: 120,
};

export type AccessDurationPolicy = {
  accessType: ContentAccessType;
  accessDurationValue: number | null;
  accessDurationUnit: AccessDurationUnit | null;
};

export function normalizeAccessDurationPolicy(input: {
  accessType: ContentAccessType;
  accessDurationValue?: number | null;
  accessDurationUnit?: AccessDurationUnit | null;
}): AccessDurationPolicy {
  if (input.accessType === "FREE") {
    return { accessType: "FREE", accessDurationValue: null, accessDurationUnit: null };
  }
  const value = input.accessDurationValue;
  const unit = input.accessDurationUnit;
  if (value == null && unit == null) {
    return { accessType: "PAID", accessDurationValue: null, accessDurationUnit: null };
  }
  if (value == null || unit == null || !Number.isInteger(value) || value <= 0 || value > ACCESS_DURATION_LIMITS[unit]) {
    throw badRequest(
      "INVALID_ACCESS_DURATION",
      `Fixed access requires a positive whole number within the allowed ${unit?.toLowerCase() ?? "duration"} limit.`,
    );
  }
  return { accessType: "PAID", accessDurationValue: value, accessDurationUnit: unit };
}

/** Calculates the exclusive expiry once, when access is activated. */
export function resolveEntitlementExpiry(
  policy: Pick<AccessDurationPolicy, "accessDurationValue" | "accessDurationUnit">,
  startsAt: Date,
) {
  if (policy.accessDurationValue == null || policy.accessDurationUnit == null) return null;
  const value = policy.accessDurationValue;
  const result = new Date(startsAt);
  if (policy.accessDurationUnit === "DAYS") result.setUTCDate(result.getUTCDate() + value);
  else if (policy.accessDurationUnit === "WEEKS") result.setUTCDate(result.getUTCDate() + value * 7);
  else {
    const originalDay = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + value);
    const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
    result.setUTCDate(Math.min(originalDay, lastDay));
  }
  return result;
}

export function accessDurationLabel(policy: Pick<AccessDurationPolicy, "accessDurationValue" | "accessDurationUnit">) {
  if (policy.accessDurationValue == null || policy.accessDurationUnit == null) return "Permanent access";
  const unit = policy.accessDurationUnit.toLowerCase();
  return `${policy.accessDurationValue} ${policy.accessDurationValue === 1 ? unit.slice(0, -1) : unit}`;
}

export function earliestExpiry(...values: Array<Date | null | undefined>) {
  const dates = values.filter((value): value is Date => value instanceof Date);
  return dates.length ? new Date(Math.min(...dates.map((value) => value.getTime()))) : null;
}
