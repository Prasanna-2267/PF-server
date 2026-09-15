import assert from "node:assert/strict";
import test from "node:test";
import { ExpoPushProvider } from "../integrations/expo-push-provider.js";

test("ExpoPushProvider maps accepted and unregistered-device tickets", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: unknown;
  globalThis.fetch = (async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ data: [
      { status: "ok", id: "ticket-1" },
      { status: "error", message: "Device is not registered", details: { error: "DeviceNotRegistered" } },
    ] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const provider = new ExpoPushProvider("https://example.test/push", "secret");
    const result = await provider.send([
      { to: "ExpoPushToken[first]", title: "One", body: "Body" },
      { to: "ExpoPushToken[second]", title: "Two", body: "Body" },
    ]);
    assert.equal(result[0]?.delivered, true);
    assert.equal(result[0]?.providerMessageId, "ticket-1");
    assert.equal(result[1]?.delivered, false);
    assert.equal(result[1]?.deviceNotRegistered, true);
    assert.deepEqual((requestBody as Array<{ channelId: string }>).map((item) => item.channelId), ["learning-reminders", "learning-reminders"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
