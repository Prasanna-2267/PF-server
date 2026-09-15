import assert from "node:assert/strict";
import { test } from "node:test";
import { hasBlockingExistingAccount } from "../auth/registration-service.js";

const importedStudent = {
  status: "ACTIVE",
  deletedAt: null,
  role: { key: "student" },
  passwordCredential: null,
};

test("a genuinely new email is allowed to begin staged registration", () => {
  assert.equal(hasBlockingExistingAccount(null), false);
});

test("an imported active student without credentials may activate the existing identity", () => {
  assert.equal(hasBlockingExistingAccount(importedStudent), false);
});

test("registered, non-student, deleted and inactive identities remain blocked", () => {
  assert.equal(hasBlockingExistingAccount({ ...importedStudent, passwordCredential: { userId: "user-id" } }), true);
  assert.equal(hasBlockingExistingAccount({ ...importedStudent, role: { key: "academy_admin" } }), true);
  assert.equal(hasBlockingExistingAccount({ ...importedStudent, deletedAt: new Date() }), true);
  assert.equal(hasBlockingExistingAccount({ ...importedStudent, status: "DISABLED" }), true);
});
