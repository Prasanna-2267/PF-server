export interface UploadIntent {
  academyId: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
}

export class StorageProviderError extends Error {
  constructor(
    public readonly operation: string,
    public readonly statusCode?: number,
    public readonly providerCode?: string,
    options?: ErrorOptions,
  ) {
    super(
      statusCode
        ? `Object storage ${operation} failed with HTTP ${statusCode}${providerCode ? ` (${providerCode})` : ""}.`
        : `Object storage ${operation} could not be completed.`,
      options,
    );
    this.name = "StorageProviderError";
  }
}

export interface StorageProvider {
  createUploadUrl(intent: UploadIntent): Promise<{ uploadUrl: string; expiresAt: Date; headers: Record<string, string> }>;
  createDownloadUrl(objectKey: string, expiresInSeconds: number): Promise<string>;
  statObject(objectKey: string): Promise<{ sizeBytes: number; mimeType: string; checksumSha256?: string }>;
  deleteObject(objectKey: string): Promise<void>;
  copyObject(sourceObjectKey: string, destinationObjectKey: string): Promise<void>;
  putObject?(objectKey: string, body: Buffer, mimeType: string, checksumSha256: string): Promise<void>;
}

// A provider is intentionally not selected here. Startup/provider wiring must supply
// a real implementation; API handlers return STORAGE_PROVIDER_NOT_CONFIGURED until then.
