import { getStorageProvider } from "../integrations/provider-registry.js";
import { badRequest, conflict } from "../errors/api-error.js";
import { isAllowedContentMimeType } from "../utils/upload-validation.js";

export interface R2UploadParams {
  courseId: string;
  pageId?: string;
  folderId?: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
}

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB max

export function sanitizeFileName(fileName: string): string {
  const normalized = fileName.normalize("NFKC").replace(/[\\/\u0000-\u001f\u007f]/g, "-").replace(/\s+/g, " ").trim();
  if (!normalized || normalized === "." || normalized === "..") {
    throw badRequest("INVALID_FILE_NAME", "A safe file name is required.");
  }
  return normalized.slice(0, 180);
}

export function buildR2ObjectKey(courseId: string, pageId: string | undefined, folderId: string | null | undefined, fileName: string): string {
  const safeName = sanitizeFileName(fileName);
  const pId = pageId || "root";
  const uniquePrefix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const keyFileName = `${uniquePrefix}-${safeName}`;

  if (folderId) {
    return `courses/${courseId}/pages/${pId}/folders/${folderId}/${keyFileName}`;
  }
  return `courses/${courseId}/pages/${pId}/root/${keyFileName}`;
}

export class R2Service {
  /**
   * Generates a short-lived presigned PUT URL for direct browser uploads to R2.
   */
  static async generateUploadPresignedUrl(params: R2UploadParams) {
    if (!isAllowedContentMimeType(params.mimeType)) {
      throw badRequest("UNSUPPORTED_FILE_TYPE", "This file type is not allowed for R2 storage.");
    }
    if (params.sizeBytes < 1 || params.sizeBytes > MAX_FILE_SIZE) {
      throw badRequest("INVALID_FILE_SIZE", `File size must be between 1 byte and ${MAX_FILE_SIZE} bytes.`);
    }

    const objectKey = buildR2ObjectKey(params.courseId, params.pageId, params.folderId, params.fileName);
    const provider = getStorageProvider();

    const intent = await provider.createUploadUrl({
      academyId: "platform",
      objectKey,
      mimeType: params.mimeType.toLowerCase(),
      sizeBytes: params.sizeBytes,
      checksumSha256: params.checksumSha256.toLowerCase(),
    });

    return {
      uploadUrl: intent.uploadUrl,
      objectKey,
      headers: intent.headers,
      expiresAt: intent.expiresAt,
    };
  }

  /**
   * Verifies that the uploaded object actually exists on R2 with expected size.
   */
  static async verifyObjectExists(objectKey: string, expectedSize?: number, expectedMime?: string) {
    const provider = getStorageProvider();
    try {
      const stat = await provider.statObject(objectKey);
      if (expectedSize && stat.sizeBytes !== expectedSize) {
        throw conflict("UPLOAD_VERIFICATION_FAILED", `R2 object size (${stat.sizeBytes}) does not match declared size (${expectedSize}).`);
      }
      return stat;
    } catch (error) {
      if (error instanceof Error && error.message.includes("UPLOAD_VERIFICATION_FAILED")) throw error;
      throw conflict("UPLOAD_VERIFICATION_FAILED", `The object key ${objectKey} could not be verified on Cloudflare R2.`);
    }
  }

  /**
   * Generates a short-lived presigned GET URL for authenticated downloads/previews.
   */
  static async generateDownloadPresignedUrl(objectKey: string, ttlSeconds = 300) {
    const provider = getStorageProvider();
    return provider.createDownloadUrl(objectKey, ttlSeconds);
  }

  /**
   * Safely deletes an object from R2 storage.
   */
  static async deleteObject(objectKey: string) {
    try {
      const provider = getStorageProvider();
      await provider.deleteObject(objectKey);
    } catch {
      // Best-effort cleanup for orphaned R2 objects
    }
  }

  /**
   * Copies an R2 object to a new destination key.
   */
  static async copyObject(sourceKey: string, destinationKey: string) {
    const provider = getStorageProvider();
    await provider.copyObject(sourceKey, destinationKey);
  }
}
