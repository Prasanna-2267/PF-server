import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { prisma } from "../db/prisma.js";
import { integrationDatabaseEnabled } from "../tests/integration-database-guard.js";
import { createApp } from "../app/create-app.js";
import { getConfig } from "../config/env.js";

const enabled = integrationDatabaseEnabled("RUN_BACKEND_INTEGRATION");

test("integration database is reachable and has Phase 2C operational tables", { skip: !enabled }, async () => {
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('BackgroundJob', 'StorageUpload', 'IdempotencyRecord', 'PaymentWebhookEvent')
  `;
  assert.deepEqual(new Set(rows.map((row) => row.table_name)), new Set(["BackgroundJob", "StorageUpload", "IdempotencyRecord", "PaymentWebhookEvent"]));
});

test("mounted API domains enforce their outer authentication boundaries", { skip: !enabled }, async () => {
  const app = createApp(getConfig());
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const { port } = server.address() as AddressInfo;
  const protectedRoutes = [
    "/api/admin/overview", "/api/admin/academies", "/api/admin/academies/00000000-0000-0000-0000-000000000000/students",
    "/api/admin/academies/00000000-0000-0000-0000-000000000000/courses", "/api/admin/academies/00000000-0000-0000-0000-000000000000/content",
    "/api/admin/academies/00000000-0000-0000-0000-000000000000/questions", "/api/admin/academies/00000000-0000-0000-0000-000000000000/broadcasts",
    "/api/admin/academies/00000000-0000-0000-0000-000000000000/audit", "/api/admin/packages", "/api/admin/questions",
    "/api/admin/content", "/api/admin/broadcasts", "/api/admin/orders", "/api/admin/audit",
    "/api/academy/context", "/api/academy/settings", "/api/academy/analytics/overview",
    "/api/academy/admissions/codes", "/api/academy/content", "/api/academy/questions",
    "/api/academy/broadcasts", "/api/academy/notifications", "/api/student/bootstrap", "/api/student/me",
    "/api/student/admissions/codes/claim", "/api/student/notifications", "/api/student/orders", "/api/student/practice/sources", "/api/student/practice/modes",
    "/api/student/practice/search", "/api/student/practice/question-banks", "/api/student/practice/sessions/resume", "/api/student/practice/wrong-answers",
    "/api/student/practice/tracker", "/api/checkout",
  ];
  try {
    for (const route of protectedRoutes) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`);
      assert.equal(response.status, 401, `${route} must be mounted behind authentication`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("public, webhook, validation, and not-found boundaries return controlled responses", { skip: !enabled }, async () => {
  const app = createApp(getConfig());
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const { port } = server.address() as AddressInfo;
  const url = (path: string) => `http://127.0.0.1:${port}${path}`;
  try {
    assert.equal((await fetch(url("/health/live"))).status, 200);
    assert.equal((await fetch(url("/api/catalog"))).status, 200);
    assert.equal((await fetch(url("/api/contact"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 422);
    assert.equal((await fetch(url("/api/payments/webhook/http"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
    assert.equal((await fetch(url("/api/auth/login"), { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })).status, 415);
    assert.equal((await fetch(url("/api/does-not-exist"))).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test.after(async () => { await prisma.$disconnect(); });
