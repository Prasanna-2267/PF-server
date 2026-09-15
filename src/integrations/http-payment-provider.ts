import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentCheckoutRequest, PaymentProvider } from "./payment-provider.js";

export class HttpPaymentProvider implements PaymentProvider {
  constructor(private readonly checkoutUrl: string, private readonly webhookSecret: string, private readonly bearerToken?: string) {}
  async #post(url: string, body: unknown, idempotencyKey: string) {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey, ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Payment provider failed with HTTP ${response.status}.`);
    return response.json() as Promise<Record<string, unknown>>;
  }
  async createCheckout(request: PaymentCheckoutRequest) {
    const payload = await this.#post(this.checkoutUrl, request, request.idempotencyKey);
    if (typeof payload.providerPaymentId !== "string" || typeof payload.redirectUrl !== "string") throw new Error("Payment provider returned an invalid checkout response.");
    return { providerPaymentId: payload.providerPaymentId, redirectUrl: payload.redirectUrl };
  }
  async verifyWebhook(rawBody: Buffer, signature: string) {
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    const supplied = signature.replace(/^sha256=/i, "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"))) throw new Error("Payment webhook signature verification failed.");
    const payload = JSON.parse(rawBody.toString("utf8")) as { eventId?: unknown; eventType?: unknown; data?: unknown };
    if (typeof payload.eventId !== "string" || typeof payload.eventType !== "string") throw new Error("Payment webhook envelope is invalid.");
    return { eventId: payload.eventId, eventType: payload.eventType, payload: payload.data };
  }
  async refund(providerPaymentId: string, amountMinor: number, idempotencyKey: string) {
    const payload = await this.#post(`${this.checkoutUrl.replace(/\/$/, "")}/refunds`, { providerPaymentId, amountMinor }, idempotencyKey);
    if (typeof payload.providerRefundId !== "string") throw new Error("Payment provider returned an invalid refund response.");
    return { providerRefundId: payload.providerRefundId };
  }
}
