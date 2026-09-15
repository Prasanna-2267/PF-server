import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { R2Service, buildR2ObjectKey, sanitizeFileName } from "../services/r2Service.js";
import { providerTestHooks } from "../integrations/provider-registry.js";
import type { StorageProvider, UploadIntent } from "../integrations/storage-provider.js";

describe("Cloudflare R2 Content Storage & PostgreSQL Metadata Integration", () => {
  let mockStorage: Map<string, { buffer: Buffer; mimeType: string; sha256: string }>;

  before(() => {
    mockStorage = new Map();

    const inMemoryR2Provider: StorageProvider = {
      async createUploadUrl(intent: UploadIntent) {
        return {
          uploadUrl: `https://r2-mock.local/${encodeURIComponent(intent.objectKey)}`,
          expiresAt: new Date(Date.now() + 900_000),
          headers: { "content-type": intent.mimeType, "x-amz-meta-sha256": intent.checksumSha256 },
        };
      },
      async createDownloadUrl(objectKey: string, expiresInSeconds: number) {
        return `https://r2-mock.local/download/${encodeURIComponent(objectKey)}?expires=${expiresInSeconds}`;
      },
      async statObject(objectKey: string) {
        const item = mockStorage.get(objectKey);
        if (!item) {
          throw new Error(`R2 Object Not Found: ${objectKey}`);
        }
        return {
          sizeBytes: item.buffer.length,
          mimeType: item.mimeType,
          checksumSha256: item.sha256,
        };
      },
      async deleteObject(objectKey: string) {
        mockStorage.delete(objectKey);
      },
      async copyObject(sourceObjectKey: string, destinationObjectKey: string) {
        const source = mockStorage.get(sourceObjectKey);
        if (!source) throw new Error("Source object missing");
        mockStorage.set(destinationObjectKey, { ...source });
      },
    };

    providerTestHooks.setStorage(inMemoryR2Provider);
  });

  after(() => {
    providerTestHooks.reset();
  });

  it("sanitizes filenames and generates deterministic R2 object keys", () => {
    const safeName = sanitizeFileName("  CA Final / Audit Notes (2026).pdf  ");
    assert.equal(safeName, "CA Final - Audit Notes (2026).pdf");

    const rootKey = buildR2ObjectKey("course-123", "page-456", null, "test-file.pdf");
    assert.match(rootKey, /^courses\/course-123\/pages\/page-456\/root\/\d+-[a-z0-9]+-test-file\.pdf$/);

    const folderKey = buildR2ObjectKey("course-123", "page-456", "folder-789", "test-file.pdf");
    assert.match(folderKey, /^courses\/course-123\/pages\/page-456\/folders\/folder-789\/\d+-[a-z0-9]+-test-file\.pdf$/);
  });

  it("generates presigned upload URL and verifies object existence before publication", async () => {
    const courseId = "11111111-1111-1111-1111-111111111111";
    const checksumSha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    const intent = await R2Service.generateUploadPresignedUrl({
      courseId,
      fileName: "Chapter-1-Notes.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      checksumSha256,
    });

    assert.ok(intent.uploadUrl.startsWith("https://r2-mock.local/"));
    assert.ok(intent.objectKey.includes("courses/11111111-1111-1111-1111-111111111111/pages/root/root/"));

    // Verify un-uploaded object fails verification
    await assert.rejects(
      async () => R2Service.verifyObjectExists(intent.objectKey, 1024),
      /could not be verified/
    );

    // Simulate successful R2 PUT upload
    mockStorage.set(intent.objectKey, {
      buffer: Buffer.alloc(1024),
      mimeType: "application/pdf",
      sha256: checksumSha256,
    });

    // Verification succeeds once object exists on R2
    const stat = await R2Service.verifyObjectExists(intent.objectKey, 1024);
    assert.equal(stat.sizeBytes, 1024);
    assert.equal(stat.mimeType, "application/pdf");
  });

  it("generates authenticated short-lived presigned GET download URLs", async () => {
    const key = "courses/c1/pages/p1/root/sample.pdf";
    const downloadUrl = await R2Service.generateDownloadPresignedUrl(key, 300);
    assert.ok(downloadUrl.includes("r2-mock.local/download/"));
    assert.ok(downloadUrl.includes("expires=300"));
  });

  it("safely deletes R2 objects on content deletion", async () => {
    const key = "courses/c1/pages/p1/root/delete-me.pdf";
    mockStorage.set(key, { buffer: Buffer.from("data"), mimeType: "application/pdf", sha256: "hash" });
    assert.ok(mockStorage.has(key));

    await R2Service.deleteObject(key);
    assert.equal(mockStorage.has(key), false);
  });
});
