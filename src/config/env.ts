import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalTrimmedString = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || undefined);

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().trim().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    DATABASE_URL: optionalTrimmedString,
    DIRECT_URL: optionalTrimmedString,
    AUTH_JWT_SECRET: z.string().min(32, "must contain at least 32 characters"),
    AUTH_ISSUER: z.string().trim().min(1).default("parallax-flow-api"),
    AUTH_AUDIENCE: z.string().trim().min(1).default("parallax-flow-web"),
    AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    AUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3600).max(7_776_000).default(2_592_000),
    CORS_ALLOWED_ORIGINS: z.string().default("http://localhost:5173"),
    TRUST_PROXY: z.string().default("false"),
    JSON_BODY_LIMIT: z.string().trim().min(1).default("1mb"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    GOOGLE_CLIENT_ID: optionalTrimmedString,
    AUTH_PASSWORD_REGISTRATION_ENABLED: booleanFromString,
    AUTH_STAGED_REGISTRATION_ENABLED: booleanFromString,
    AUTH_GOOGLE_REGISTRATION_ENABLED: booleanFromString,
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(900_000),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(10_000).default(300),
    AUTH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(1_000).default(10),
    STORAGE_DRIVER: z.enum(["disabled", "s3"]).default("disabled"),
    R2_ACCOUNT_ID: optionalTrimmedString,
    R2_ACCESS_KEY_ID: optionalTrimmedString,
    R2_SECRET_ACCESS_KEY: optionalTrimmedString,
    R2_BUCKET_NAME: optionalTrimmedString,
    R2_ENDPOINT: optionalTrimmedString,
    STORAGE_S3_ENDPOINT: optionalTrimmedString,
    STORAGE_S3_REGION: z.string().trim().min(1).default("auto"),
    STORAGE_S3_BUCKET: optionalTrimmedString,
    STORAGE_S3_ACCESS_KEY_ID: optionalTrimmedString,
    STORAGE_S3_SECRET_ACCESS_KEY: optionalTrimmedString,
    STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    EMAIL_WEBHOOK_URL: optionalTrimmedString,
    EMAIL_WEBHOOK_BEARER_TOKEN: optionalTrimmedString,
    EMAIL_PROVIDER: z.enum(["http", "smtp"]).default("http"),
    SMTP_HOST: optionalTrimmedString,
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(465),
    SMTP_SECURE: booleanFromString,
    SMTP_USER: optionalTrimmedString,
    SMTP_PASSWORD: optionalTrimmedString,
    SMTP_FROM: optionalTrimmedString,
    CONTACT_RECIPIENT_EMAIL: optionalTrimmedString,
    PUBLIC_APP_URL: optionalTrimmedString,
    PUBLIC_LOGO_URL: optionalTrimmedString,
    SUPPORT_EMAIL: optionalTrimmedString,
    SMS_WEBHOOK_URL: optionalTrimmedString,
    SMS_WEBHOOK_BEARER_TOKEN: optionalTrimmedString,
    PAYMENT_CHECKOUT_URL: optionalTrimmedString,
    PAYMENT_WEBHOOK_SECRET: optionalTrimmedString,
    PAYMENT_BEARER_TOKEN: optionalTrimmedString,
    PAYMENT_PROVIDER_NAME: z.string().trim().regex(/^[a-z0-9_-]{2,40}$/).default("http"),
    FAKE_PAYMENT_ENABLED: booleanFromString,
    EXPO_PUSH_ENDPOINT: z.string().url().default("https://exp.host/--/api/v2/push/send"),
    EXPO_ACCESS_TOKEN: optionalTrimmedString,
  })
  .superRefine((value, context) => {
    if (!value.DATABASE_URL && !value.DIRECT_URL) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "DATABASE_URL or DIRECT_URL is required",
      });
    }

    if (value.NODE_ENV === "production" && !value.CORS_ALLOWED_ORIGINS.trim()) {
      context.addIssue({
        code: "custom",
        path: ["CORS_ALLOWED_ORIGINS"],
        message: "must contain at least one explicit production origin",
      });
    }
    if (value.NODE_ENV === "production" && value.AUTH_STAGED_REGISTRATION_ENABLED) {
      const smtpConfigured = Boolean(value.SMTP_HOST && value.SMTP_USER && value.SMTP_PASSWORD && value.SMTP_FROM);
      if (value.EMAIL_PROVIDER === "smtp" && !smtpConfigured) context.addIssue({ code: "custom", path: ["SMTP_HOST"], message: "complete SMTP configuration is required when production staged registration is enabled" });
      if (value.EMAIL_PROVIDER === "http" && !value.EMAIL_WEBHOOK_URL) context.addIssue({ code: "custom", path: ["EMAIL_WEBHOOK_URL"], message: "is required when production staged registration is enabled" });
    }
    if (value.EMAIL_PROVIDER === "smtp") {
      for (const field of ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"] as const) {
        if (!value[field]) context.addIssue({ code: "custom", path: [field], message: "is required when EMAIL_PROVIDER=smtp" });
      }
    }
    if (value.NODE_ENV === "production" && value.FAKE_PAYMENT_ENABLED) {
      context.addIssue({ code: "custom", path: ["FAKE_PAYMENT_ENABLED"], message: "must be false in production" });
    }
    const hasR2 = Boolean(value.R2_ACCESS_KEY_ID && value.R2_SECRET_ACCESS_KEY);
    if (value.STORAGE_DRIVER === "s3" && !hasR2) {
      for (const field of ["STORAGE_S3_ENDPOINT", "STORAGE_S3_BUCKET", "STORAGE_S3_ACCESS_KEY_ID", "STORAGE_S3_SECRET_ACCESS_KEY"] as const) {
        if (!value[field]) context.addIssue({ code: "custom", path: [field], message: "is required when STORAGE_DRIVER=s3" });
      }
    }
  });

export interface AppConfig {
  environment: "development" | "test" | "production";
  server: {
    host: string;
    port: number;
    trustProxy: boolean | number;
    jsonBodyLimit: string;
  };
  databaseUrl: string;
  auth: {
    jwtSecret: string;
    issuer: string;
    audience: string;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    googleClientId?: string;
    passwordRegistrationEnabled: boolean;
    stagedRegistrationEnabled: boolean;
    googleRegistrationEnabled: boolean;
  };
  corsOrigins: ReadonlySet<string>;
  logLevel: "debug" | "info" | "warn" | "error";
  rateLimit: {
    windowMs: number;
    maxRequests: number;
    authMaxRequests: number;
  };
  storage: {
    driver: "disabled" | "s3";
    endpoint?: string;
    region: string;
    bucket?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    signedUrlTtlSeconds: number;
  };
  email: {
    driver: "http" | "smtp";
    webhookUrl?: string;
    bearerToken?: string;
    contactRecipient?: string;
    smtp: { host?: string; port: number; secure: boolean; user?: string; password?: string; from?: string };
  };
  branding: { appUrl: string; logoUrl: string; supportEmail: string };
  sms: { webhookUrl?: string; bearerToken?: string };
  payment: { providerName: string; checkoutUrl?: string; webhookSecret?: string; bearerToken?: string; fakePaymentEnabled: boolean };
  push: { endpoint: string; accessToken?: string };
}

const parseTrustProxy = (value: string): boolean | number => {
  if (value === "true") return true;
  if (value === "false" || value.trim() === "") return false;
  const hops = Number(value);
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) {
    throw new Error("TRUST_PROXY must be true, false, or an integer from 0 to 10.");
  }
  return hops;
};

export const parseEnvironment = (input: NodeJS.ProcessEnv): AppConfig => {
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid server configuration: ${fields.join("; ")}`);
  }

  const env = result.data;
  const corsOrigins = new Set(
    env.CORS_ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

  for (const origin of corsOrigins) {
    const parsed = new URL(origin);
    if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`Invalid CORS origin: ${origin}. Origins must not contain paths.`);
    }
    if (env.NODE_ENV === "production" && parsed.protocol !== "https:") {
      throw new Error(`Production CORS origin must use HTTPS: ${origin}.`);
    }
  }

  const endpoint = env.STORAGE_S3_ENDPOINT || env.R2_ENDPOINT || (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);
  const bucket = env.STORAGE_S3_BUCKET || env.R2_BUCKET_NAME;
  const accessKeyId = env.STORAGE_S3_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.STORAGE_S3_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY;
  const hasS3Config = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
  const driver = env.STORAGE_DRIVER === "s3" || hasS3Config ? "s3" : "disabled";
  const appUrl = env.PUBLIC_APP_URL ?? corsOrigins.values().next().value;
  if (!appUrl) throw new Error("Invalid server configuration: PUBLIC_APP_URL is required when no CORS origin is configured");
  const parsedAppUrl = new URL(appUrl);
  if (!/^https?:$/.test(parsedAppUrl.protocol)) throw new Error("Invalid server configuration: PUBLIC_APP_URL must use HTTP or HTTPS");
  const logoUrl = env.PUBLIC_LOGO_URL ?? new URL("/logo.png", parsedAppUrl).toString();
  const parsedLogoUrl = new URL(logoUrl);
  if (!/^https?:$/.test(parsedLogoUrl.protocol)) throw new Error("Invalid server configuration: PUBLIC_LOGO_URL must use HTTP or HTTPS");
  const senderAddress = env.SMTP_FROM?.match(/<([^>]+)>/)?.[1] ?? env.SMTP_FROM;

  return {
    environment: env.NODE_ENV,
    server: {
      host: env.HOST,
      port: env.PORT,
      trustProxy: parseTrustProxy(env.TRUST_PROXY),
      jsonBodyLimit: env.JSON_BODY_LIMIT,
    },
    databaseUrl: env.DATABASE_URL ?? env.DIRECT_URL!,
    auth: {
      jwtSecret: env.AUTH_JWT_SECRET,
      issuer: env.AUTH_ISSUER,
      audience: env.AUTH_AUDIENCE,
      accessTokenTtlSeconds: env.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: env.AUTH_REFRESH_TOKEN_TTL_SECONDS,
      googleClientId: env.GOOGLE_CLIENT_ID,
      passwordRegistrationEnabled: env.AUTH_PASSWORD_REGISTRATION_ENABLED,
      stagedRegistrationEnabled: env.AUTH_STAGED_REGISTRATION_ENABLED,
      googleRegistrationEnabled: env.AUTH_GOOGLE_REGISTRATION_ENABLED,
    },
    corsOrigins,
    logLevel: env.LOG_LEVEL,
    rateLimit: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
      authMaxRequests: env.AUTH_RATE_LIMIT_MAX_REQUESTS,
    },
    storage: {
      driver,
      endpoint,
      region: env.STORAGE_S3_REGION,
      bucket,
      accessKeyId,
      secretAccessKey,
      signedUrlTtlSeconds: env.STORAGE_SIGNED_URL_TTL_SECONDS,
    },
    email: {
      driver: env.EMAIL_PROVIDER,
      webhookUrl: env.EMAIL_WEBHOOK_URL,
      bearerToken: env.EMAIL_WEBHOOK_BEARER_TOKEN,
      contactRecipient: env.CONTACT_RECIPIENT_EMAIL,
      smtp: { host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, user: env.SMTP_USER, password: env.SMTP_PASSWORD, from: env.SMTP_FROM },
    },
    branding: {
      appUrl: parsedAppUrl.toString(),
      logoUrl: parsedLogoUrl.toString(),
      supportEmail: env.SUPPORT_EMAIL ?? env.CONTACT_RECIPIENT_EMAIL ?? senderAddress ?? "support@parallaxflow.com",
    },
    sms: { webhookUrl: env.SMS_WEBHOOK_URL, bearerToken: env.SMS_WEBHOOK_BEARER_TOKEN },
    payment: { providerName: env.PAYMENT_PROVIDER_NAME, checkoutUrl: env.PAYMENT_CHECKOUT_URL, webhookSecret: env.PAYMENT_WEBHOOK_SECRET, bearerToken: env.PAYMENT_BEARER_TOKEN, fakePaymentEnabled: env.FAKE_PAYMENT_ENABLED },
    push: { endpoint: env.EXPO_PUSH_ENDPOINT, accessToken: env.EXPO_ACCESS_TOKEN },
  };
};

let cachedConfig: AppConfig | undefined;

export const getConfig = (): AppConfig => {
  cachedConfig ??= parseEnvironment(process.env);
  return cachedConfig;
};
