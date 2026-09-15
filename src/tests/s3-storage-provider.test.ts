import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { S3StorageProvider } from "../integrations/s3-storage-provider.js";
import { StorageProviderError } from "../integrations/storage-provider.js";

const originalFetch = globalThis.fetch;
const provider = () => new S3StorageProvider({
  endpoint: "https://account-id.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "nonproduction-content",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  signedUrlTtlSeconds: 900,
});

afterEach(() => { globalThis.fetch = originalFetch; });

describe("S3-compatible content storage provider", () => {
  it("generates a bucket-scoped signed URL with the required integrity headers", async () => {
    const signed = await provider().createUploadUrl({
      academyId: "academy-a",
      objectKey: "courses/course-a/root/Study Notes.pdf",
      mimeType: "application/pdf",
      sizeBytes: 12,
      checksumSha256: "a".repeat(64),
    });
    const url = new URL(signed.uploadUrl);
    assert.equal(url.host, "account-id.r2.cloudflarestorage.com");
    assert.equal(url.pathname, "/nonproduction-content/courses/course-a/root/Study%20Notes.pdf");
    assert.match(url.searchParams.get("X-Amz-SignedHeaders") ?? "", /content-type/);
    assert.equal(signed.headers["x-amz-meta-sha256"], "a".repeat(64));
  });

  it("retries transient provider failures and completes the same idempotent PUT", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return attempts < 3 ? new Response("temporary", { status: 503 }) : new Response(null, { status: 200 });
    }) as typeof fetch;
    await provider().putObject("courses/course-a/root/file.txt", Buffer.from("hello"), "text/plain", "b".repeat(64));
    assert.equal(attempts, 3);
  });

  it("does not retry a permanent authorization failure and exposes a typed safe error", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    }) as typeof fetch;
    await assert.rejects(
      provider().statObject("courses/course-a/root/file.txt"),
      (error: unknown) => error instanceof StorageProviderError
        && error.statusCode === 403
        && error.providerCode === "AccessDenied",
    );
    assert.equal(attempts, 1);
  });
});
