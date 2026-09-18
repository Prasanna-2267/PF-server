import type { EmailMessage, EmailProvider } from "./email-provider.js";
import { assertSafeEmailRecipient, maskMailbox } from "./email-delivery-safety.js";
import { logger } from "../observability/logger.js";

export class HttpEmailProvider implements EmailProvider {
  constructor(private readonly url: string, private readonly bearerToken?: string) {}
  async send(message: EmailMessage) {
    assertSafeEmailRecipient(message);
    const fields = { provider: "http", template: message.template, recipient: maskMailbox(message.to), recipientSource: message.recipientSource };
    logger.info("email.delivery_started", fields);
    try {
      const response = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json", ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}), "idempotency-key": message.idempotencyKey }, body: JSON.stringify(message), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Email provider failed with HTTP ${response.status}.`);
      const payload = await response.json() as { providerMessageId?: unknown; id?: unknown };
      const providerMessageId = typeof payload.providerMessageId === "string" ? payload.providerMessageId : typeof payload.id === "string" ? payload.id : undefined;
      if (!providerMessageId) throw new Error("Email provider response did not include a message ID.");
      logger.info("email.delivery_succeeded", { ...fields, providerMessageId });
      return { providerMessageId };
    } catch (error) {
      const failure = error as { name?: unknown; code?: unknown; command?: unknown; responseCode?: unknown };
      logger.error("email.delivery_failed", undefined, { ...fields, errorName: failure.name, errorCode: failure.code, command: failure.command, responseCode: failure.responseCode });
      throw error;
    }
  }
}
