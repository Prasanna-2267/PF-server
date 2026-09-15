import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../db/prisma.js";
import { badRequest, conflict, notFound } from "../errors/api-error.js";
import { getStorageProvider } from "../integrations/provider-registry.js";
import { assertFileNameMatchesMime } from "../utils/upload-validation.js";

export interface BroadcastMediaScope { academyId: string | null; actorId: string }
async function owned(scope: BroadcastMediaScope, broadcastId: string) {
  const item = await prisma.broadcast.findFirst({ where: { id: broadcastId, academyId: scope.academyId, deletedAt: null } });
  if (!item) throw notFound("BROADCAST_NOT_FOUND", "The broadcast was not found in the current scope.");
  return item;
}
export async function createImageUpload(scope: BroadcastMediaScope, broadcastId: string, input: { fileName: string; mimeType: string; sizeBytes: number; checksumSha256: string }) {
  const broadcast = await owned(scope, broadcastId);
  if (!new Set(["DRAFT", "SCHEDULED"]).has(broadcast.status)) throw conflict("BROADCAST_IMAGE_IMMUTABLE", "Images can only be changed on draft or scheduled broadcasts.");
  if (!/^image\/(jpeg|png|webp|gif)$/i.test(input.mimeType) || input.sizeBytes > 10 * 1024 * 1024) throw badRequest("INVALID_BROADCAST_IMAGE", "Broadcast images must be JPEG, PNG, WebP, or GIF files no larger than 10 MB.");
  assertFileNameMatchesMime(input.fileName, input.mimeType);
  const objectKey = `academies/${scope.academyId ?? "platform"}/broadcasts/${broadcastId}/${randomUUID()}/${encodeURIComponent(input.fileName.replace(/[\\/]/g, "-").slice(0, 180))}`;
  const signed = await getStorageProvider().createUploadUrl({ academyId: scope.academyId ?? "platform", objectKey, mimeType: input.mimeType, sizeBytes: input.sizeBytes, checksumSha256: input.checksumSha256.toLowerCase() });
  const upload = await prisma.storageUpload.create({ data: { academyId: scope.academyId, createdById: scope.actorId, objectKey, originalName: input.fileName, mimeType: input.mimeType, sizeBytes: BigInt(input.sizeBytes), checksumSha256: input.checksumSha256.toLowerCase(), purpose: `BROADCAST_IMAGE:${broadcastId}`, expiresAt: signed.expiresAt } });
  return { uploadId: upload.id, uploadUrl: signed.uploadUrl, headers: signed.headers, expiresAt: signed.expiresAt };
}
export async function uploadImageBytes(scope: BroadcastMediaScope, broadcastId: string, uploadId: string, body: Buffer) {
  await owned(scope, broadcastId);
  const upload = await prisma.storageUpload.findFirst({ where: { id: uploadId, academyId: scope.academyId, createdById: scope.actorId, purpose: `BROADCAST_IMAGE:${broadcastId}`, status: "PENDING" } });
  if (!upload) throw notFound("UPLOAD_NOT_FOUND", "The broadcast image upload was not found.");
  if (upload.expiresAt <= new Date()) throw conflict("UPLOAD_EXPIRED", "The broadcast image upload session has expired.");
  if (body.byteLength !== Number(upload.sizeBytes)) throw badRequest("UPLOAD_SIZE_MISMATCH", "The uploaded image size does not match the declared size.");
  const checksum = createHash("sha256").update(body).digest("hex");
  if (checksum !== upload.checksumSha256.toLowerCase()) throw badRequest("UPLOAD_CHECKSUM_MISMATCH", "The uploaded image checksum does not match the declared checksum.");
  const storage = getStorageProvider();
  if (!storage.putObject) throw conflict("STORAGE_PROXY_UNAVAILABLE", "The configured storage provider does not support authenticated server uploads.");
  await storage.putObject(upload.objectKey, body, upload.mimeType, upload.checksumSha256);
  return finalizeImage(scope, broadcastId, uploadId);
}
export async function finalizeImage(scope: BroadcastMediaScope, broadcastId: string, uploadId: string) {
  await owned(scope, broadcastId);
  const upload = await prisma.storageUpload.findFirst({ where: { id: uploadId, academyId: scope.academyId, createdById: scope.actorId, purpose: `BROADCAST_IMAGE:${broadcastId}`, status: "PENDING" } });
  if (!upload) throw notFound("UPLOAD_NOT_FOUND", "The broadcast image upload was not found.");
  const stat = await getStorageProvider().statObject(upload.objectKey);
  if (stat.sizeBytes !== Number(upload.sizeBytes) || stat.mimeType.toLowerCase() !== upload.mimeType.toLowerCase() || stat.checksumSha256?.toLowerCase() !== upload.checksumSha256) throw conflict("UPLOAD_VERIFICATION_FAILED", "Stored broadcast image metadata does not match the declaration.");
  return prisma.$transaction(async (tx) => {
    const image = await tx.broadcastImage.upsert({ where: { broadcastId }, create: { broadcastId, name: upload.originalName, mimeType: upload.mimeType, size: upload.sizeBytes, storagePath: upload.objectKey }, update: { name: upload.originalName, mimeType: upload.mimeType, size: upload.sizeBytes, storagePath: upload.objectKey } });
    await tx.storageUpload.update({ where: { id: upload.id }, data: { status: "FINALIZED", finalizedAt: new Date() } });
    await tx.systemAuditLog.create({ data: { actorId: scope.actorId, academyId: scope.academyId, action: "BROADCAST_IMAGE_UPDATED", entityType: "Broadcast", entityId: broadcastId, description: "Updated broadcast image through verified object storage." } });
    return { ...image, size: Number(image.size) };
  });
}
export async function getImageUrl(scope: BroadcastMediaScope, broadcastId: string) { await owned(scope, broadcastId); const image = await prisma.broadcastImage.findUnique({ where: { broadcastId } }); if (!image) throw notFound("BROADCAST_IMAGE_NOT_FOUND", "The broadcast has no image."); return { url: await getStorageProvider().createDownloadUrl(image.storagePath, 300), mimeType: image.mimeType, expiresIn: 300 }; }
export async function deleteImage(scope: BroadcastMediaScope, broadcastId: string) { await owned(scope, broadcastId); const image = await prisma.broadcastImage.findUnique({ where: { broadcastId } }); if (!image) throw notFound("BROADCAST_IMAGE_NOT_FOUND", "The broadcast has no image."); await getStorageProvider().deleteObject(image.storagePath); await prisma.broadcastImage.delete({ where: { broadcastId } }); return { id: image.id, deleted: true }; }
