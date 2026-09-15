import { getConfig } from "../config/env.js";
import { serviceUnavailable } from "../errors/api-error.js";
import { S3StorageProvider } from "./s3-storage-provider.js";
import type { EmailProvider } from "./email-provider.js";
import type { PaymentProvider } from "./payment-provider.js";
import type { StorageProvider } from "./storage-provider.js";
import { HttpEmailProvider } from "./http-email-provider.js";
import { HttpPaymentProvider } from "./http-payment-provider.js";
import { HttpSmsProvider } from "./http-sms-provider.js";
import type { SmsProvider } from "./sms-provider.js";
import type { PushProvider } from "./push-provider.js";
import { ExpoPushProvider } from "./expo-push-provider.js";
import { SmtpEmailProvider } from "./smtp-email-provider.js";

let storageOverride: StorageProvider | undefined;
let emailOverride: EmailProvider | undefined;
let paymentOverride: PaymentProvider | undefined;
let smsOverride: SmsProvider | undefined;
let pushOverride: PushProvider | undefined;

export function getStorageProvider(): StorageProvider {
  if (storageOverride) return storageOverride;
  const config = getConfig().storage;
  if (config.driver !== "s3") throw serviceUnavailable("STORAGE_PROVIDER_NOT_CONFIGURED", "Durable object storage is not configured.");
  return new S3StorageProvider({
    endpoint: config.endpoint!, region: config.region, bucket: config.bucket!, accessKeyId: config.accessKeyId!,
    secretAccessKey: config.secretAccessKey!, signedUrlTtlSeconds: config.signedUrlTtlSeconds,
  });
}

export function getEmailProvider(): EmailProvider {
  if (emailOverride) return emailOverride;
  const config = getConfig().email;
  if (config.driver === "smtp") {
    return new SmtpEmailProvider({
      host: config.smtp.host!, port: config.smtp.port, secure: config.smtp.secure,
      user: config.smtp.user!, password: config.smtp.password!, from: config.smtp.from!,
    });
  }
  if (config.webhookUrl) return new HttpEmailProvider(config.webhookUrl, config.bearerToken);
  throw serviceUnavailable("EMAIL_PROVIDER_NOT_CONFIGURED", "Email delivery is not configured.");
}

export function getPaymentProvider(): PaymentProvider {
  if (paymentOverride) return paymentOverride;
  const config = getConfig().payment;
  if (config.checkoutUrl && config.webhookSecret) return new HttpPaymentProvider(config.checkoutUrl, config.webhookSecret, config.bearerToken);
  throw serviceUnavailable("PAYMENT_PROVIDER_NOT_CONFIGURED", "Payment processing is not configured.");
}

export function getSmsProvider(): SmsProvider {
  if (smsOverride) return smsOverride;
  const config = getConfig().sms;
  if (config.webhookUrl) return new HttpSmsProvider(config.webhookUrl, config.bearerToken);
  throw serviceUnavailable("SMS_PROVIDER_NOT_CONFIGURED", "SMS delivery is not configured.");
}

export function getPushProvider(): PushProvider {
  if (pushOverride) return pushOverride;
  const config = getConfig().push;
  return new ExpoPushProvider(config.endpoint, config.accessToken);
}

export const providerTestHooks = {
  setStorage(provider?: StorageProvider) { storageOverride = provider; },
  setEmail(provider?: EmailProvider) { emailOverride = provider; },
  setPayment(provider?: PaymentProvider) { paymentOverride = provider; },
  setSms(provider?: SmsProvider) { smsOverride = provider; },
  setPush(provider?: PushProvider) { pushOverride = provider; },
  reset() { storageOverride = undefined; emailOverride = undefined; paymentOverride = undefined; smsOverride = undefined; pushOverride = undefined; },
};
