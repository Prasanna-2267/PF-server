import assert from "node:assert/strict";
import { test } from "node:test";
import { academyProvisioningSchema } from "../domain/academyProvisioning.js";

const validPayload = () => ({
  requestKey: "academy-create-request-0001",
  academy: {
    name: "Parallax Learning Private Limited",
    displayName: "Parallax Academy",
    type: "PROFESSIONAL_COACHING" as const,
    email: "academy@example.com",
    phone: "+91 98765 43210",
  },
  primaryAdmin: {
    fullName: "Primary Administrator",
    email: "admin@example.com",
    mobile: "+91 98765 43211",
  },
  contacts: [],
  legal: {
    entityType: "PRIVATE_LIMITED" as const,
    panStatus: "NOT_AVAILABLE" as const,
    gstStatus: "NO" as const,
  },
  addresses: {
    academy: {
      addressLine1: "12 Learning Street",
      city: "Chennai",
      state: "Tamil Nadu",
      country: "India",
      postalCode: "600001",
    },
    billingSameAsAcademy: true,
  },
  billing: { purchaseOrderRequired: false, currency: "INR" },
  academic: { categories: ["CA"], programs: ["CA Intermediate"] },
  commercial: {
    planKey: "STARTER",
    subscriptionStatus: "TRIAL" as const,
    startDate: "2026-08-30",
    endDate: "2027-08-30",
    studentSeatLimit: 100,
    billingCycle: "ANNUAL" as const,
  },
});

test("academy provisioning accepts a complete normalized tenant request", () => {
  assert.equal(academyProvisioningSchema.safeParse(validPayload()).success, true);
});

test("academy provisioning requires conditional GST and billing data", () => {
  const payload = validPayload();
  const invalid = {
    ...payload,
    legal: { ...payload.legal, gstStatus: "YES" as const },
    addresses: { ...payload.addresses, billingSameAsAcademy: false },
  };
  const result = academyProvisioningSchema.safeParse(invalid);
  assert.equal(result.success, false);
  if (!result.success) {
    const paths = result.error.issues.map((issue) => issue.path.join("."));
    assert.ok(paths.includes("legal.gstin"));
    assert.ok(paths.includes("legal.gstState"));
    assert.ok(paths.includes("addresses.billing"));
  }
});

test("academy provisioning rejects invalid subscription ranges and empty academic scope", () => {
  const payload = validPayload();
  const result = academyProvisioningSchema.safeParse({
    ...payload,
    academic: { categories: [], programs: [] },
    commercial: { ...payload.commercial, startDate: "2027-08-30", endDate: "2026-08-30", studentSeatLimit: 0 },
  });
  assert.equal(result.success, false);
});
