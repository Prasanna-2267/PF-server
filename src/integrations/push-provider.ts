export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  priority?: "default" | "normal" | "high";
}

export interface PushReceipt {
  token: string;
  delivered: boolean;
  providerMessageId?: string;
  error?: string;
  deviceNotRegistered?: boolean;
}

export interface PushProvider {
  send(messages: PushMessage[]): Promise<PushReceipt[]>;
}
