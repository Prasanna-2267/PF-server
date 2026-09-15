import type { PushMessage, PushProvider, PushReceipt } from "./push-provider.js";

type ExpoTicket = { status?: string; id?: string; message?: string; details?: { error?: string } };

export class ExpoPushProvider implements PushProvider {
  constructor(private readonly endpoint: string, private readonly accessToken?: string) {}

  async send(messages: PushMessage[]): Promise<PushReceipt[]> {
    if (!messages.length) return [];
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: JSON.stringify(messages.map((message) => ({ ...message, sound: "default", channelId: "learning-reminders" }))),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`EXPO_PUSH_HTTP_${response.status}`);
    const payload = await response.json() as { data?: ExpoTicket[] };
    const tickets = Array.isArray(payload.data) ? payload.data : [];
    return messages.map((message, index) => {
      const ticket = tickets[index];
      const error = ticket?.details?.error ?? ticket?.message;
      return {
        token: message.to,
        delivered: ticket?.status === "ok",
        providerMessageId: ticket?.id,
        error,
        deviceNotRegistered: error === "DeviceNotRegistered",
      } satisfies PushReceipt;
    });
  }
}
