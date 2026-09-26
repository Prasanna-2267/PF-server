import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

const args = process.argv.slice(2);
const readOption = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const sourcePath = path.resolve(readOption("--source", ".env"));
const outputPath = path.resolve(readOption("--output", "deploy/cloud-run.env.yaml"));
const templateMode = args.includes("--template");
const examplePath = path.resolve(".env.example");

if (!fs.existsSync(sourcePath)) throw new Error(`Environment source not found: ${sourcePath}`);
if (!fs.existsSync(examplePath)) throw new Error(`Environment contract not found: ${examplePath}`);

const source = dotenv.parse(fs.readFileSync(sourcePath));
const defaults = dotenv.parse(fs.readFileSync(examplePath));
const excluded = new Set([
  "PORT",
  "TEST_DATABASE_URL",
  "RUN_BACKEND_INTEGRATION",
]);

const values = {};
for (const key of Object.keys(defaults)) {
  if (excluded.has(key)) continue;
  values[key] = source[key] ?? defaults[key] ?? "";
}

values.NODE_ENV = "production";
values.HOST = "0.0.0.0";
values.TRUST_PROXY = "true";
const publicAppUrl = readOption("--public-app-url", undefined);
if (publicAppUrl) {
  const normalizedPublicAppUrl = new URL(publicAppUrl).origin;
  values.PUBLIC_APP_URL = normalizedPublicAppUrl;
  values.CORS_ALLOWED_ORIGINS = normalizedPublicAppUrl;
}

const isPlaceholder = (value) => /(?:USER:PASSWORD|HOST:5432|example\.com|your-|CHANGE_ME)/i.test(value);
const requireValue = (key) => {
  const value = values[key]?.trim();
  if (!value || isPlaceholder(value)) throw new Error(`${key} must have a real production value in ${sourcePath}.`);
  return value;
};
const requireHttpsUrl = (key) => {
  const value = requireValue(key);
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error(`${key} must use HTTPS in production.`);
  return value;
};

if (!templateMode) {
  requireValue("DATABASE_URL");
  requireValue("DIRECT_URL");
  if (requireValue("AUTH_JWT_SECRET").length < 32) throw new Error("AUTH_JWT_SECRET must contain at least 32 characters.");
  const origins = requireValue("CORS_ALLOWED_ORIGINS").split(",").map((value) => value.trim()).filter(Boolean);
  if (!origins.length) throw new Error("CORS_ALLOWED_ORIGINS must contain at least one production origin.");
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.origin !== origin) throw new Error(`Invalid production CORS origin: ${origin}`);
  }
  requireHttpsUrl("PUBLIC_APP_URL");
  requireHttpsUrl("NEURALWEB_LABS_URL");
  requireHttpsUrl("EXPO_PUSH_ENDPOINT");
  requireValue("SUPPORT_EMAIL");
  if (values.FAKE_PAYMENT_ENABLED === "true" && values.PILOT_FAKE_PAYMENT_ENABLED !== "true") {
    throw new Error("PILOT_FAKE_PAYMENT_ENABLED must be true while the explicitly approved fake payment flow is enabled.");
  }
}

const yaml = Object.entries(values)
  .map(([key, value]) => `${key}: ${JSON.stringify(String(value))}`)
  .join("\n") + "\n";

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, yaml, { encoding: "utf8", mode: 0o600 });
console.log(`Wrote ${Object.keys(values).length} Cloud Run environment variables to ${path.relative(process.cwd(), outputPath)}. PORT was intentionally omitted because Cloud Run reserves it.`);