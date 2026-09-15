import { randomUUID } from "node:crypto";
import { prisma } from "../db/prisma.js";
import { badRequest, conflict, notFound } from "../errors/api-error.js";
import { getStorageProvider } from "../integrations/provider-registry.js";

type AssetKind = "LOGO" | "GST_CERTIFICATE";

const allowed = (kind: AssetKind, mimeType: string, sizeBytes: number) => {
  const mime = mimeType.toLowerCase();
  if (kind === "LOGO" && !["image/jpeg", "image/png", "image/webp"].includes(mime)) throw badRequest("INVALID_LOGO_TYPE", "Academy logo must be JPEG, PNG, or WebP.");
  if (kind === "GST_CERTIFICATE" && !["application/pdf", "image/jpeg", "image/png"].includes(mime)) throw badRequest("INVALID_GST_CERTIFICATE_TYPE", "GST certificate must be PDF, JPEG, or PNG.");
  const limit = kind === "LOGO" ? 5 * 1024 * 1024 : 10 * 1024 * 1024;
  if (sizeBytes < 1 || sizeBytes > limit) throw badRequest("INVALID_ASSET_SIZE", `The selected file must be smaller than ${limit / 1024 / 1024} MB.`);
};

export async function createOnboardingAssetIntent(actorId: string, input: { kind: AssetKind; fileName: string; mimeType: string; sizeBytes: number; checksumSha256: string }) {
  allowed(input.kind, input.mimeType, input.sizeBytes);
  if (!/^[a-f0-9]{64}$/i.test(input.checksumSha256)) throw badRequest("INVALID_CHECKSUM", "A valid SHA-256 checksum is required.");
  const extension = input.fileName.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 8) || "bin";
  const objectKey = `academy-onboarding/${actorId}/${randomUUID()}/${input.kind.toLowerCase()}.${extension}`;
  const signed = await getStorageProvider().createUploadUrl({ academyId: "platform", objectKey, mimeType: input.mimeType, sizeBytes: input.sizeBytes, checksumSha256: input.checksumSha256.toLowerCase() });
  const upload = await prisma.storageUpload.create({ data: { createdById: actorId, objectKey, originalName: input.fileName, mimeType: input.mimeType, sizeBytes: BigInt(input.sizeBytes), checksumSha256: input.checksumSha256.toLowerCase(), purpose: `ACADEMY_ONBOARDING_${input.kind}`, expiresAt: signed.expiresAt }, select: { id: true, expiresAt: true } });
  return { uploadId: upload.id, uploadUrl: signed.uploadUrl, headers: signed.headers, expiresAt: upload.expiresAt };
}

export async function finalizeOnboardingAsset(actorId: string, uploadId: string) {
  const upload = await prisma.storageUpload.findFirst({ where: { id: uploadId, createdById: actorId, academyId: null, purpose: { startsWith: "ACADEMY_ONBOARDING_" }, status: "PENDING", expiresAt: { gt: new Date() } } });
  if (!upload) throw notFound("UPLOAD_NOT_FOUND", "The academy onboarding upload was not found or has expired.");
  const object = await getStorageProvider().statObject(upload.objectKey);
  if (object.sizeBytes !== Number(upload.sizeBytes) || object.mimeType.toLowerCase() !== upload.mimeType.toLowerCase() || (object.checksumSha256 && object.checksumSha256.toLowerCase() !== upload.checksumSha256)) throw conflict("UPLOAD_VERIFICATION_FAILED", "The uploaded file did not match its declared metadata.");
  return prisma.storageUpload.update({ where: { id: upload.id }, data: { status: "AVAILABLE", finalizedAt: new Date() }, select: { id: true, originalName: true, mimeType: true, sizeBytes: true } });
}
