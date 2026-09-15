import assert from "node:assert/strict";
import { test } from "node:test";
import { assertTenantResourceAccess, type TenantContext } from "../auth/tenant-auth.js";

const context: TenantContext = {
  user: { id: "user-a", email: "admin@example.test", fullName: "Admin", roleKey: "admin" },
  academyId: "academy-a",
  roleInAcademy: "ACADEMY_ADMIN",
  membershipId: "membership-a",
  permissions: new Set(["academy:manage"]),
  isSuperAdmin: false,
};

test("tenant resource assertions reject a foreign academy", () => {
  assert.doesNotThrow(() => assertTenantResourceAccess(context, "academy-a"));
  assert.throws(() => assertTenantResourceAccess(context, "academy-b"));
});

test("a trusted Super Admin context can cross academy boundaries", () => {
  assert.doesNotThrow(() => assertTenantResourceAccess({ ...context, isSuperAdmin: true }, "academy-b"));
});
