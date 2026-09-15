export interface SmsMessage {
  to: string;
  template: string;
  variables: Record<string, string>;
  idempotencyKey: string;
}

export interface SmsProvider {
  send(message: SmsMessage): Promise<{ providerMessageId: string }>;
}
