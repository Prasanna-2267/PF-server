import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertIntegrationDatabase } from "../tests/integration-database-guard.js";

assertIntegrationDatabase("RUN_BACKEND_INTEGRATION");
process.env.NODE_ENV = "test";
process.env.AUTH_JWT_SECRET = "phase-4-integration-only-secret-never-use-in-production";
process.env.CORS_ALLOWED_ORIGINS = "http://localhost:5173";
process.env.STORAGE_DRIVER = "disabled";
process.env.AUTH_STAGED_REGISTRATION_ENABLED = "true";
// Keep explicit empty values in the child environment so dotenv cannot reload
// real provider credentials from server/.env during disposable integration runs.
for (const providerVariable of [
  "STORAGE_S3_ENDPOINT", "STORAGE_S3_BUCKET", "STORAGE_S3_ACCESS_KEY_ID", "STORAGE_S3_SECRET_ACCESS_KEY",
  "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_ENDPOINT",
  "EMAIL_WEBHOOK_URL", "EMAIL_WEBHOOK_BEARER_TOKEN", "CONTACT_RECIPIENT_EMAIL",
  "SMS_WEBHOOK_URL", "SMS_WEBHOOK_BEARER_TOKEN",
  "PAYMENT_CHECKOUT_URL", "PAYMENT_WEBHOOK_SECRET", "PAYMENT_BEARER_TOKEN",
]) process.env[providerVariable] = "";
process.env.FAKE_PAYMENT_ENABLED = "false";
for (const flag of ["ADMISSIONS_TEST_DATABASE", "ANALYTICS_TEST_DATABASE", "NOTIFICATION_TEST_DATABASE", "SETTINGS_TEST_DATABASE"]) process.env[flag] = "1";

const tsxCli = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const files = [
  "src/tests/**/*.test.ts",
  "src/admissions/*.test.ts",
  "src/analytics/*.test.ts",
  "src/auth/*.test.ts",
  "src/notifications/*.test.ts",
  "src/settings/*.test.ts",
  "src/integration/*.test.ts",
];
const result = spawnSync(process.execPath, [tsxCli, "--test", "--test-concurrency=1", ...files], { stdio: "inherit", env: process.env });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Full integration suite failed with exit code ${result.status ?? "unknown"}.`);
