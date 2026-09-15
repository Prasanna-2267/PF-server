import { Prisma } from "../../generated/prisma/client.js";
import { z } from "zod";
import { getConfig } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { getEmailProvider } from "../integrations/provider-registry.js";

export const ACCOUNT_CREATED_EMAIL_JOB = "ACCOUNT_CREATED_EMAIL";

const accountCreatedPayloadSchema = z.object({
  userId: z.string().uuid(),
  recipientEmail: z.string().email(),
  userName: z.string().trim().min(1).max(200),
  accountCreatedAt: z.string().datetime(),
  academyId: z.string().uuid().optional(),
}).strict();

export type AccountCreatedEmailInput = z.infer<typeof accountCreatedPayloadSchema>;

/**
 * Transactional outbox write for a newly-created account. The no-op update is
 * intentional: a retry of the creation request must never requeue a delivered
 * welcome email.
 */
export function enqueueAccountCreatedEmail(
  transaction: Prisma.TransactionClient,
  input: AccountCreatedEmailInput,
) {
  const payload = accountCreatedPayloadSchema.parse(input);
  return transaction.backgroundJob.upsert({
    where: {
      kind_deduplicationKey: {
        kind: ACCOUNT_CREATED_EMAIL_JOB,
        deduplicationKey: payload.userId,
      },
    },
    create: {
      kind: ACCOUNT_CREATED_EMAIL_JOB,
      deduplicationKey: payload.userId,
      payload,
      academyId: payload.academyId,
      createdById: payload.userId,
      runAt: new Date(),
      maxAttempts: 5,
    },
    update: {},
  });
}

const formatCreatedAt = (value: string) => `${new Intl.DateTimeFormat("en", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "UTC",
}).format(new Date(value))} UTC`;

/** Called only by the durable worker after the account transaction commits. */
export async function deliverAccountCreatedEmail(payloadValue: unknown) {
  const payload = accountCreatedPayloadSchema.parse(payloadValue);
  const academy = payload.academyId
    ? await prisma.academy.findFirst({
        where: { id: payload.academyId, deletedAt: null },
        select: { name: true },
      })
    : null;
  const config = getConfig();
  try {
    return await getEmailProvider().send({
      to: payload.recipientEmail,
      template: "account-created",
      variables: {
        userName: payload.userName,
        userEmail: payload.recipientEmail,
        createdAt: formatCreatedAt(payload.accountCreatedAt),
        academyName: academy?.name ?? "",
        supportEmail: config.branding.supportEmail,
        appUrl: config.branding.appUrl,
        logoUrl: config.branding.logoUrl,
        currentYear: String(new Date().getUTCFullYear()),
      },
      idempotencyKey: `account-created:${payload.userId}`,
    });
  } catch {
    // Provider errors can contain transport/server details. Persist a stable,
    // non-secret failure code while the durable worker schedules the retry.
    throw new Error("ACCOUNT_CREATED_EMAIL_PROVIDER_UNAVAILABLE");
  }
}
