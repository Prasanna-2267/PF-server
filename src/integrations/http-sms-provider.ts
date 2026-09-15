import type { SmsMessage, SmsProvider } from "./sms-provider.js";

export class HttpSmsProvider implements SmsProvider {
  constructor(private readonly url: string, private readonly bearerToken?: string) {}

  async send(message: SmsMessage) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}),
        "idempotency-key": message.idempotencyKey,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`SMS provider failed with HTTP ${response.status}.`);
    const payload = await response.json() as { providerMessageId?: unknown; id?: unknown };
    const providerMessageId = typeof payload.providerMessageId === "string"
      ? payload.providerMessageId
      : typeof payload.id === "string" ? payload.id : undefined;
    if (!providerMessageId) throw new Error("SMS provider response did not include a message ID.");
    return { providerMessageId };
  }
}
