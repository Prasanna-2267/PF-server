import assert from "node:assert/strict";
import { test } from "node:test";
import type { Prisma } from "../../generated/prisma/client.js";
import { ACCOUNT_CREATED_EMAIL_JOB, enqueueAccountCreatedEmail } from "../services/accountCreatedEmailService.js";

test("account-created outbox writes are stable and never requeue a duplicate", async () => {
  let captured: Record<string, unknown> | undefined;
  const transaction = {
    backgroundJob: {
      upsert: async (args: Record<string, unknown>) => {
        captured = args;
        return { id: "job" };
      },
    },
  } as unknown as Prisma.TransactionClient;
  const userId = "3e9bf9bd-d943-4d50-8c4f-a0f06182e6b1";

  await enqueueAccountCreatedEmail(transaction, {
    userId,
    recipientEmail: "learner@example.test",
    userName: "Learner",
    accountCreatedAt: "2026-08-29T10:30:00.000Z",
    academyId: "7e286daa-caa4-459a-8782-6b2c509b10f3",
  });

  const where = captured?.where as { kind_deduplicationKey: { kind: string; deduplicationKey: string } };
  assert.equal(where.kind_deduplicationKey.kind, ACCOUNT_CREATED_EMAIL_JOB);
  assert.equal(where.kind_deduplicationKey.deduplicationKey, userId);
  assert.deepEqual(captured?.update, {});
  assert.equal((captured?.create as { maxAttempts: number }).maxAttempts, 5);
});

test("account-created outbox rejects malformed or unsafe event payloads", () => {
  const transaction = { backgroundJob: { upsert: async () => ({ id: "job" }) } } as unknown as Prisma.TransactionClient;
  assert.throws(() => enqueueAccountCreatedEmail(transaction, {
    userId: "not-a-uuid",
    recipientEmail: "not-an-email",
    userName: "",
    accountCreatedAt: "not-a-date",
  }));
});
