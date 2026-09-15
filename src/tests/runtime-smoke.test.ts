import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/parallax_test";
process.env.AUTH_JWT_SECRET = "runtime-test-secret-with-at-least-thirty-two-characters";
process.env.CORS_ALLOWED_ORIGINS = "https://allowed.example";

test("runtime exposes health and safe API error envelopes without a database connection", async () => {
  const [{ createApp }, { parseEnvironment }] = await Promise.all([
    import("../app/create-app.js"),
    import("../config/env.js"),
  ]);
  const config = parseEnvironment({ ...process.env, JSON_BODY_LIMIT: "128b" });
  const server = createServer(createApp(config));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const live = await fetch(`${base}/health/live`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: "ok" });

    const protectedResponse = await fetch(`${base}/api/admin/overview`);
    const protectedBody = await protectedResponse.json() as { error: { code: string; requestId: string } };
    assert.equal(protectedResponse.status, 401);
    assert.equal(protectedBody.error.code, "AUTHENTICATION_REQUIRED");
    assert.ok(protectedBody.error.requestId);

    const malformed = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as { error: { code: string } }).error.code, "MALFORMED_JSON");

    const emptyPost = await fetch(`${base}/api/auth/logout`, { method: "POST" });
    assert.equal(emptyPost.status, 401);
    assert.equal(((await emptyPost.json()) as { error: { code: string } }).error.code, "AUTHENTICATION_REQUIRED");

    const nonJsonBody = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "text/plain" }, body: "email=test@example.com" });
    assert.equal(nonJsonBody.status, 415);
    assert.equal(((await nonJsonBody.json()) as { error: { code: string } }).error.code, "UNSUPPORTED_MEDIA_TYPE");

    const deniedCors = await fetch(`${base}/health/live`, { headers: { origin: "https://denied.example" } });
    assert.equal(deniedCors.status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
