import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEnvironment } from "../config/env.js";

const validEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:password@localhost:5432/test",
  AUTH_JWT_SECRET: "a-test-secret-with-at-least-thirty-two-characters",
  CORS_ALLOWED_ORIGINS: "http://localhost:5173,https://example.test",
  PUBLIC_APP_URL: "https://app.example.test",
  SUPPORT_EMAIL: "support@example.test",
  NEURALWEB_LABS_URL: "https://neuralweblabs.example",
  EXPO_PUSH_ENDPOINT: "https://push.example.test/send",
};

test("configuration parsing keeps explicit CORS origins and safe defaults", () => {
  const config = parseEnvironment(validEnvironment);
  assert.equal(config.server.port, 4000);
  assert.equal(config.corsOrigins.has("http://localhost:5173"), true);
  assert.equal(config.corsOrigins.has("https://example.test"), true);
  assert.equal(config.auth.passwordRegistrationEnabled, false);
  assert.equal(config.auth.stagedRegistrationEnabled, false);
  assert.equal(config.branding.appUrl, "https://app.example.test/");
  assert.equal(config.branding.logoUrl, "https://app.example.test/logo.png");
});

test("configuration fails closed without database or signing secrets", () => {
  assert.throws(() => parseEnvironment({ ...validEnvironment, DATABASE_URL: undefined, DIRECT_URL: undefined }), /DATABASE_URL/);
  assert.throws(() => parseEnvironment({ ...validEnvironment, AUTH_JWT_SECRET: undefined }), /AUTH_JWT_SECRET/);
});

test("production rejects insecure CORS origins", () => {
  assert.throws(() => parseEnvironment({
    ...validEnvironment,
    NODE_ENV: "production",
    CORS_ALLOWED_ORIGINS: "http://example.test",
  }), /HTTPS/);
});

test("production permits HTTP only for explicit loopback development origins", () => {
  const config = parseEnvironment({
    ...validEnvironment,
    NODE_ENV: "production",
    CORS_ALLOWED_ORIGINS: "https://www.parallaxflow.in,http://localhost:5173,http://127.0.0.1:8081",
  });
  assert.equal(config.corsOrigins.has("http://localhost:5173"), true);
  assert.equal(config.corsOrigins.has("http://127.0.0.1:8081"), true);
  assert.throws(() => parseEnvironment({
    ...validEnvironment,
    NODE_ENV: "production",
    CORS_ALLOWED_ORIGINS: "http://192.168.1.10:5173",
  }), /HTTPS/);
});

test("transactional email branding accepts explicit public production URLs", () => {
  const config = parseEnvironment({
    ...validEnvironment,
    PUBLIC_APP_URL: "https://learn.parallaxflow.example/app",
    PUBLIC_LOGO_URL: "https://cdn.parallaxflow.example/logo.png",
    SUPPORT_EMAIL: "help@parallaxflow.example",
  });
  assert.equal(config.branding.appUrl, "https://learn.parallaxflow.example/app");
  assert.equal(config.branding.logoUrl, "https://cdn.parallaxflow.example/logo.png");
  assert.equal(config.branding.supportEmail, "help@parallaxflow.example");
});

test("production staged registration requires email delivery only", () => {
  assert.throws(() => parseEnvironment({
    ...validEnvironment,
    NODE_ENV: "production",
    CORS_ALLOWED_ORIGINS: "https://example.test",
    AUTH_STAGED_REGISTRATION_ENABLED: "true",
  }), /EMAIL_WEBHOOK_URL/);

  const config = parseEnvironment({
    ...validEnvironment,
    NODE_ENV: "production",
    CORS_ALLOWED_ORIGINS: "https://example.test",
    AUTH_STAGED_REGISTRATION_ENABLED: "true",
    EMAIL_WEBHOOK_URL: "https://providers.example.test/email",
  });
  assert.equal(config.auth.stagedRegistrationEnabled, true);
});

test("SMTP is a valid staged-registration email transport", () => {
  const config = parseEnvironment({
    ...validEnvironment,
    NODE_ENV: "production",
    CORS_ALLOWED_ORIGINS: "https://example.test",
    AUTH_STAGED_REGISTRATION_ENABLED: "true",
    EMAIL_PROVIDER: "smtp",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: "mailer@example.test",
    SMTP_PASSWORD: "provider-app-password",
    SMTP_FROM: "Parallax Flow <mailer@example.test>",
    SMTP_REPLY_TO: "support@example.test",
  });

  assert.equal(config.email.driver, "smtp");
  assert.equal(config.email.smtp.secure, true);
  assert.equal(config.email.smtp.port, 465);
  assert.equal(config.email.smtp.replyTo, "support@example.test");
});
