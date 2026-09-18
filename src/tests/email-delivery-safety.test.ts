import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSafeEmailRecipient, maskMailbox, normalizeMailbox } from "../integrations/email-delivery-safety.js";

const base = {
  to: "learner@example.test",
  recipientSource: "registered-user" as const,
  template: "user-lifecycle",
  variables: {},
  idempotencyKey: "test-delivery",
};

test("email delivery safety accepts one classified database recipient", () => {
  assert.doesNotThrow(() => assertSafeEmailRecipient(base, "Parallax Flow <sender@example.test>"));
  assert.doesNotThrow(() => assertSafeEmailRecipient({ ...base, to: "Learner@Example.test" }));
});

test("email delivery safety rejects unclassified, multiple and header-injected recipients", () => {
  assert.throws(() => assertSafeEmailRecipient({ ...base, recipientSource: undefined }), /EMAIL_RECIPIENT_SOURCE_REQUIRED/);
  assert.throws(() => assertSafeEmailRecipient({ ...base, to: "one@example.test,two@example.test" }), /EMAIL_RECIPIENT_INVALID/);
  assert.throws(() => assertSafeEmailRecipient({ ...base, to: "one@example.test\r\nBcc: other@example.test" }), /EMAIL_RECIPIENT_INVALID/);
});

test("sender mailbox is accepted only when an intentional recipient source is present", () => {
  assert.throws(() => assertSafeEmailRecipient({ ...base, to: "sender@example.test", recipientSource: undefined }, "Parallax Flow <sender@example.test>"), /EMAIL_RECIPIENT_SOURCE_REQUIRED/);
  assert.doesNotThrow(() => assertSafeEmailRecipient({ ...base, to: "sender@example.test", recipientSource: "registered-user" }, "Parallax Flow <sender@example.test>"));
});

test("email delivery logs can use a masked recipient without exposing its local part", () => {
  assert.equal(normalizeMailbox("Parallax Flow <Sender@Example.test>"), "sender@example.test");
  assert.equal(maskMailbox("student.name@example.test"), "st**********@example.test");
});
