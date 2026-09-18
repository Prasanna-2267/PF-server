import type { EmailMessage } from "./email-provider.js";

const SINGLE_EMAIL = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;

export const normalizeMailbox = (value: string): string => {
  const match = value.trim().match(/^(?:[^<>]*<)?([^<>\s]+@[^<>\s]+)>?$/);
  return (match?.[1] ?? value).trim().toLowerCase();
};

export const maskMailbox = (value: string): string => {
  const normalized = normalizeMailbox(value);
  const [local = "", domain = ""] = normalized.split("@");
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(3, local.length - visible.length))}@${domain}`;
};

export function assertSafeEmailRecipient(message: EmailMessage, configuredSender?: string): void {
  const rawRecipient = message.to.trim();
  if (rawRecipient !== message.to || /[\r\n]/.test(message.to) || !SINGLE_EMAIL.test(rawRecipient)) throw new Error("EMAIL_RECIPIENT_INVALID");
  const recipient = rawRecipient.toLowerCase();
  if (!message.recipientSource) throw new Error("EMAIL_RECIPIENT_SOURCE_REQUIRED");
  if (configuredSender && normalizeMailbox(configuredSender) === recipient) {
    const intentionalSources = new Set(["registered-user", "registration-challenge", "verified-new-email", "configured-contact"]);
    if (!intentionalSources.has(message.recipientSource)) throw new Error("EMAIL_RECIPIENT_MATCHES_SENDER");
  }
}