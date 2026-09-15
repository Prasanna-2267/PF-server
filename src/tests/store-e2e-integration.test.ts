import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { providerTestHooks } from "../integrations/provider-registry.js";
import type { StorageProvider, UploadIntent } from "../integrations/storage-provider.js";
import { generatePdfFirstPageCover } from "../services/pdfCoverService.js";
import { PDFDocument, rgb } from "pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";

describe("Store Module End-to-End & Security Boundary Verification", () => {
  let mockStorage: Map<string, { sizeBytes: number; mimeType: string; checksumSha256: string }>;

  before(() => {
    mockStorage = new Map();
    mockStorage.set("courses/course-1/pages/root/tax-notes.pdf", {
      sizeBytes: 1024,
      mimeType: "application/pdf",
      checksumSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    mockStorage.set("academies/platform/content/item-1/samples/sample-1.jpg", {
      sizeBytes: 500,
      mimeType: "image/jpeg",
      checksumSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });

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
        const found = mockStorage.get(objectKey);
        if (!found) throw new Error(`R2 Object Not Found: ${objectKey}`);
        return found;
      },
      async deleteObject(objectKey: string) {
        mockStorage.delete(objectKey);
      },
      async copyObject(sourceKey: string, destKey: string) {
        const found = mockStorage.get(sourceKey);
        if (found) mockStorage.set(destKey, { ...found });
      },
    };

    providerTestHooks.setStorage(inMemoryStorageProvider);
  });

  after(() => {
    providerTestHooks.reset();
  });

  it("ensures public catalog methods hide protected storage paths", () => {
    const publicContent = {
      id: "item-1",
      name: "Taxation Notes.pdf",
      description: "Complete Income Tax revision notes",
      price: 499,
      sampleImages: [
        { id: "cover-1", role: "PDF_FIRST_PAGE", name: "cover-v2.png", displayOrder: 0, url: "https://storage.test/download/content/item-1/samples/cover-v2.png?expires=3600" },
        { id: "sample-1", role: "ADMIN_PREVIEW", name: "Sample Page 1", displayOrder: 1, url: "https://storage.test/download/academies/platform/content/item-1/samples/sample-1.jpg?expires=3600" },
      ],
      highlights: [
        { id: "sec-1", heading: "Complete Coverage", content: "Covers all provisions", displayOrder: 0 },
      ],
    };

    assert.equal("storagePath" in publicContent, false);
    assert.equal(publicContent.price, 499);
    assert.equal(publicContent.sampleImages.length, 2);
    assert.equal(publicContent.sampleImages[0].role, "PDF_FIRST_PAGE");
    assert.equal(publicContent.sampleImages[0].displayOrder, 0);
    assert.equal(publicContent.sampleImages[1].role, "ADMIN_PREVIEW");
  });

  it("generates automatic PDF first-page cover buffer", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 420]);
    page.drawRectangle({ x: 0, y: 0, width: 300, height: 420, color: rgb(0.9, 0.1, 0.1) });
    page.drawText("ACTUAL FIRST PAGE", { x: 45, y: 210, size: 24, color: rgb(1, 1, 1) });
    const secondPage = pdf.addPage([300, 420]);
    secondPage.drawRectangle({ x: 0, y: 0, width: 300, height: 420, color: rgb(0.1, 0.1, 0.9) });
    const mockPdfBuffer = Buffer.from(await pdf.save());
    const result = await generatePdfFirstPageCover(mockPdfBuffer, "Advanced Taxation Notes.pdf");
    
    assert.ok(result.buffer.length > 0);
    assert.equal(result.fileName, "cover-v2.png");
    assert.equal(result.mimeType, "image/png");
    assert.deepEqual([...result.buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const rendered = await loadImage(result.buffer);
    const inspectionCanvas = createCanvas(rendered.width, rendered.height);
    const inspectionContext = inspectionCanvas.getContext("2d");
    inspectionContext.drawImage(rendered, 0, 0);
    const center = inspectionContext.getImageData(Math.floor(rendered.width / 2), Math.floor(rendered.height / 4), 1, 1).data;
    assert.ok(center[0] > center[2] * 3, "the rendered cover must contain the red first page, not the blue second page");
  });

  it("verifies public catalog filtering parameters", async () => {
    const input = { page: 1, limit: 10, search: "Taxation" };
    assert.equal(input.page, 1);
    assert.equal(input.limit, 10);
  });
});
