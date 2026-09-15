export interface PaymentCheckoutRequest {
  orderId: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
}

export interface PaymentProvider {
  createCheckout(request: PaymentCheckoutRequest): Promise<{ providerPaymentId: string; redirectUrl: string }>;
  verifyWebhook(rawBody: Buffer, signature: string): Promise<{ eventId: string; eventType: string; payload: unknown }>;
  refund(providerPaymentId: string, amountMinor: number, idempotencyKey: string): Promise<{ providerRefundId: string }>;
}
