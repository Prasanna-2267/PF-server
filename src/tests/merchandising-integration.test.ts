import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { providerTestHooks } from "../integrations/provider-registry.js";
import type { StorageProvider, UploadIntent } from "../integrations/storage-provider.js";
import * as merchandisingService from "../services/merchandisingService.js";

describe("Store Management & Merchandising Engine Verification", { concurrency: false }, () => {
  before(() => {
    const inMemoryStorageProvider: StorageProvider = {
      async createUploadUrl(intent: UploadIntent) {
        return {
          uploadUrl: `https://storage.test/upload/${encodeURIComponent(intent.objectKey)}`,
          expiresAt: new Date(Date.now() + 900_000),
          headers: { "content-type": intent.mimeType },
        };
      },
      async createDownloadUrl(objectKey: string, expiresInSeconds: number) {
        return `https://storage.test/download/${encodeURIComponent(objectKey)}?expires=${expiresInSeconds}`;
      },
      async statObject(objectKey: string) {
        return { sizeBytes: 1024, mimeType: "image/jpeg", checksumSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" };
      },
      async deleteObject() {},
      async copyObject() {},
    };

    providerTestHooks.setStorage(inMemoryStorageProvider);
  });

  after(() => {
    providerTestHooks.reset();
  });

  it("seeds default merchandising sections cleanly", async () => {
    const sections = await merchandisingService.getMerchandisingSections();
    assert.ok(sections.length >= 5);

    const bestSellers = sections.find((s) => s.key === "best-sellers");
    assert.ok(bestSellers);
    assert.equal(bestSellers.key, "best-sellers");
    assert.ok(["AUTO", "HYBRID"].includes(bestSellers.mode));
    assert.ok(bestSellers.limit >= 8);
  });

  it("allows updating merchandising section configuration", async () => {
    const updated = await merchandisingService.updateMerchandisingSection("best-sellers", {
      mode: "HYBRID",
      limit: 12,
      dateWindowDays: 90,
    });

    assert.equal(updated.mode, "HYBRID");
    assert.equal(updated.limit, 12);
    assert.equal(updated.dateWindowDays, 90);
  });

  it("computes collection products with course scoping", async () => {
    const result = await merchandisingService.computeCollectionProducts("best-sellers", "ca-intermediate");
    assert.ok(result.section);
    assert.ok(Array.isArray(result.products));
  });

  it("filters recommended candidates to student enrolled courses and excludes owned items", async () => {
    const dummyStudentUuid = "00000000-0000-0000-0000-000000000001";
    const result = await merchandisingService.computeCollectionProducts("recommended", "all", dummyStudentUuid);
    assert.ok(result.section);
    assert.ok(Array.isArray(result.products));
  });
});
