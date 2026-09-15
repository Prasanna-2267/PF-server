import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { HttpPaymentProvider } from "../integrations/http-payment-provider.js";
import { S3StorageProvider } from "../integrations/s3-storage-provider.js";

test("S3 upload intents sign required metadata without exposing credentials", async () => {
  const provider = new S3StorageProvider({ endpoint: "https://objects.example.test", region: "auto", bucket: "pf-test", accessKeyId: "test-access", secretAccessKey: "do-not-expose-this-secret", signedUrlTtlSeconds: 300 });
  const intent = await provider.createUploadUrl({ academyId: "academy", objectKey: "academies/a/course/file.pdf", mimeType: "application/pdf", sizeBytes: 42, checksumSha256: "a".repeat(64) });
  assert.match(intent.uploadUrl, /X-Amz-Signature=/);
  assert.equal(intent.headers["content-type"], "application/pdf");
  assert.equal(intent.headers["x-amz-meta-sha256"], "a".repeat(64));
  assert.ok(!intent.uploadUrl.includes("do-not-expose-this-secret"));
});

test("payment webhook verification rejects tampering and returns only verified data", async () => {
  const provider = new HttpPaymentProvider("https://payments.example.test/checkout", "webhook-secret");
  const body = Buffer.from(JSON.stringify({ eventId: "evt_1", eventType: "PAYMENT_SUCCEEDED", data: { providerPaymentId: "pay_1", status: "SUCCESS" } }));
  const signature = createHmac("sha256", "webhook-secret").update(body).digest("hex");
  assert.deepEqual(await provider.verifyWebhook(body, signature), { eventId: "evt_1", eventType: "PAYMENT_SUCCEEDED", payload: { providerPaymentId: "pay_1", status: "SUCCESS" } });
  await assert.rejects(() => provider.verifyWebhook(Buffer.concat([body, Buffer.from(" ")]), signature));
});
