import { createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma } from "../../generated/prisma/client.js";
import { getConfig } from "../config/env.js";
import { forbidden, badRequest } from "../errors/api-error.js";
import type { RequestMetadata } from "./types.js";
import { enqueueUserLifecycleEmail } from "../services/userLifecycleEmailService.js";

const RESET_WINDOW_MS = 7 * 24 * 60 * 60_000;

const digest = (namespace: string, value: string) =>
  createHmac("sha256", getConfig().auth.jwtSecret).update(`${namespace}:${value}`).digest("hex");

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};

export const isNativeClient = (metadata: RequestMetadata) => metadata.platform === "ANDROID" || metadata.platform === "IOS";

export function deviceHashes(metadata: RequestMetadata) {
  if (!metadata.deviceId || metadata.deviceId.length < 20 || metadata.deviceId.length > 160 ||
      !metadata.deviceSecret || metadata.deviceSecret.length < 32 || metadata.deviceSecret.length > 256) {
    throw badRequest("DEVICE_IDENTITY_REQUIRED", "A secure mobile device identity is required.");
  }
  return {
    deviceIdHash: digest("device-id", metadata.deviceId),
    deviceSecretHash: digest("device-secret", metadata.deviceSecret),
  };
}

export async function verifyOrBindStudentDevice(
  tx: Prisma.TransactionClient,
  userId: string,
  metadata: RequestMetadata,
) {
  if (!isNativeClient(metadata)) return null;
  const hashes = deviceHashes(metadata);
  const now = new Date();
  const binding = await tx.studentDeviceBinding.findUnique({ where: { userId } });
  if (!binding) {
    return tx.studentDeviceBinding.create({
      data: { userId, ...hashes, deviceName: metadata.deviceName?.slice(0, 128), platform: metadata.platform ?? "UNKNOWN" },
    });
  }
  if (safeEqual(binding.deviceIdHash, hashes.deviceIdHash) && safeEqual(binding.deviceSecretHash, hashes.deviceSecretHash)) {
    // Once an administrator approves replacement, the old device must not be
    // able to reclaim the account by signing in again. If the seven-day
    // replacement window expires, another approval is required.
    const replacementPending = binding.resetApprovedAt && !binding.resetConsumedAt;
    if (replacementPending) {
      throw forbidden("DEVICE_CHANGE_PENDING", "This is still the currently linked device. Sign in from the different replacement device to complete the approved device change.");
    }
    return tx.studentDeviceBinding.update({ where: { userId }, data: { lastVerifiedAt: now, deviceName: metadata.deviceName?.slice(0, 128) ?? binding.deviceName, platform: metadata.platform ?? binding.platform } });
  }
  const resetUsable = binding.resetApprovedAt && !binding.resetConsumedAt && binding.resetApprovedAt.getTime() >= now.getTime() - RESET_WINDOW_MS;
  if (!resetUsable) {
    throw forbidden("DEVICE_NOT_APPROVED", "This account is permanently linked to another device. Ask an administrator to approve a one-time device change.");
  }
  const next = await tx.studentDeviceBinding.update({
    where: { userId },
    data: { ...hashes, deviceName: metadata.deviceName?.slice(0, 128), platform: metadata.platform ?? "UNKNOWN", boundAt: now, lastVerifiedAt: now, bindingVersion: { increment: 1 }, resetConsumedAt: now },
  });
  await tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, refreshTokenHash: null } });
  await tx.systemAuditLog.create({ data: { action: "STUDENT_DEVICE_RESET_CONSUMED", entityType: "StudentDeviceBinding", entityId: userId, actorId: binding.resetApprovedById, description: "Consumed an administrator-approved one-time student device change.", before: { bindingVersion: binding.bindingVersion }, after: { bindingVersion: next.bindingVersion, platform: next.platform } } });
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, fullName: true } });
  await enqueueUserLifecycleEmail(tx, { deduplicationKey: `device-changed:${userId}:${next.bindingVersion}`, recipientEmail: user.email, userName: user.fullName, event: "DEVICE_CHANGED", occurredAt: now.toISOString(), details: { oldDevice: [binding.deviceName, binding.platform].filter(Boolean).join(" / ") || "Unknown device", newDevice: [next.deviceName, next.platform].filter(Boolean).join(" / ") || "Unknown device" } });
  return next;
}
