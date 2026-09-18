export interface EmailMessage {
  to: string;
  recipientSource?: "registered-user" | "registration-challenge" | "verified-new-email" | "configured-contact";
  template: string;
  variables: Record<string, string>;
  idempotencyKey: string;
  attachments?: Array<{
    fileName: string;
    contentType: string;
    contentBase64: string;
  }>;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<{ providerMessageId: string }>;
}
