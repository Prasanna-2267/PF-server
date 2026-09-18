import { Prisma } from "../../generated/prisma/client.js";
import { z } from "zod";
import { getEmailProvider } from "../integrations/provider-registry.js";

export const USER_LIFECYCLE_EMAIL_JOB = "USER_LIFECYCLE_EMAIL";

const eventSchema = z.enum([
  "REFUND_ISSUED", "ACCOUNT_DISABLED", "ACCOUNT_ENABLED", "ACCOUNT_DELETED",
  "PASSWORD_CHANGED", "EMAIL_CHANGED_OLD", "EMAIL_CHANGED_NEW", "PHONE_CHANGED", "DEVICE_CHANGED",
]);

const payloadSchema = z.object({
  deduplicationKey: z.string().trim().min(1).max(300),
  recipientEmail: z.string().email(),
  userName: z.string().trim().min(1).max(200),
  event: eventSchema,
  occurredAt: z.string().datetime(),
  details: z.record(z.string(), z.string()).default({}),
}).strict();

export type UserLifecycleEmailInput = z.input<typeof payloadSchema>;

export function enqueueUserLifecycleEmail(tx: Prisma.TransactionClient, input: UserLifecycleEmailInput) {
  const payload = payloadSchema.parse(input);
  return tx.backgroundJob.upsert({
    where: { kind_deduplicationKey: { kind: USER_LIFECYCLE_EMAIL_JOB, deduplicationKey: payload.deduplicationKey } },
    create: { kind: USER_LIFECYCLE_EMAIL_JOB, deduplicationKey: payload.deduplicationKey, payload, runAt: new Date(), maxAttempts: 5 },
    update: {},
  });
}

export async function deliverUserLifecycleEmail(value: unknown) {
  const payload = payloadSchema.parse(value);
  try {
    return await getEmailProvider().send({
      to: payload.recipientEmail,
      recipientSource: "registered-user",
      template: "user-lifecycle",
      variables: { userName: payload.userName, event: payload.event, occurredAt: payload.occurredAt, ...payload.details },
      idempotencyKey: `user-lifecycle:${payload.deduplicationKey}`,
    });
  } catch {
    throw new Error("USER_LIFECYCLE_EMAIL_PROVIDER_UNAVAILABLE");
  }
}
