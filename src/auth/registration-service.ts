import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.js";
import { getConfig } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { ApiError, badRequest, conflict, notFound, serviceUnavailable } from "../errors/api-error.js";
import { getEmailProvider } from "../integrations/provider-registry.js";
import { hashPassword } from "./password.js";
import { createSession } from "./auth-service.js";
import type { AuthResult, RequestMetadata } from "./types.js";
import { redeemAdmissionProof } from "../services/academyAdmissionsService.js";
import { enqueueAccountCreatedEmail } from "../services/accountCreatedEmailService.js";
import { deviceHashes } from "./device-binding.js";

type OtpChannel = "email";

const CHALLENGE_TTL_MS = 15 * 60 * 1_000;
const RESEND_COOLDOWN_MS = 30 * 1_000;
const MAX_ATTEMPTS = 5;
const MAX_RESENDS = 5;

const normalizeEmail = (value: string) => value.trim().toLowerCase();

type ExistingRegistrationUser = {
  status: string;
  deletedAt: Date | null;
  role: { key: string };
  passwordCredential: { userId: string } | null;
};

export const hasBlockingExistingAccount = (existingUser: ExistingRegistrationUser | null): boolean =>
  Boolean(existingUser && (
    existingUser.passwordCredential
    || existingUser.role.key !== "student"
    || existingUser.deletedAt
    || existingUser.status !== "ACTIVE"
  ));

const normalizePhone = (value: string): string => {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  const normalized = trimmed.startsWith("+") ? `+${digits}` : digits.length === 10 ? `+91${digits}` : `+${digits}`;
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw badRequest("INVALID_PHONE", "Enter a valid mobile number including its country code.", { phone: ["Enter a valid mobile number."] });
  }
  return normalized;
};

const newOtp = () => randomInt(0, 10_000).toString().padStart(4, "0");

const otpHash = (registrationId: string, channel: OtpChannel, code: string) =>
  createHmac("sha256", getConfig().auth.jwtSecret).update(`${registrationId}:${channel}:${code}`).digest("hex");

const otpMatches = (expected: string, actual: string) => {
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
};

const maskEmail = (email: string) => {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}${"*".repeat(Math.max(2, local.length - 2))}@${domain}`;
};

const assertChallengeUsable = (challenge: { completedAt: Date | null; cancelledAt: Date | null; expiresAt: Date }) => {
  if (challenge.completedAt) throw conflict("REGISTRATION_ALREADY_COMPLETED", "This registration has already been completed.");
  if (challenge.cancelledAt) throw new ApiError(410, "REGISTRATION_REPLACED", "This registration was replaced by a newer request.");
  if (challenge.expiresAt <= new Date()) throw new ApiError(410, "REGISTRATION_EXPIRED", "This registration has expired. Start again.");
};

const deliveryFailure = () =>
  serviceUnavailable("OTP_DELIVERY_UNAVAILABLE", "The email verification code could not be delivered. Try again.");

const deliverOtp = async (challenge: { id: string; email: string; phone: string; fullName: string }, channel: OtpChannel, code: string) => {
  const config = getConfig();
  if (config.environment !== "production") {
    const configured = config.email.driver === "smtp" || Boolean(config.email.webhookUrl);
    if (!configured) return { developmentCode: code };
  }

  try {
    await getEmailProvider().send({
      to: challenge.email,
      recipientSource: "registration-challenge",
      template: "registration-otp",
      variables: { name: challenge.fullName, code, expiresInMinutes: String(CHALLENGE_TTL_MS / 60_000) },
      idempotencyKey: `registration:${challenge.id}:email:${otpHash(challenge.id, channel, code).slice(0, 16)}`,
    });
    return {};
  } catch {
    throw deliveryFailure();
  }
};

const channelState = (challenge: {
  emailOtpHash: string | null;
  emailAttempts: number;
  emailResendCount: number;
  emailSentAt: Date | null;
  emailVerifiedAt: Date | null;
}, _channel: OtpChannel) => ({
  hash: challenge.emailOtpHash, attempts: challenge.emailAttempts, resendCount: challenge.emailResendCount,
  sentAt: challenge.emailSentAt, verifiedAt: challenge.emailVerifiedAt,
});

export async function createRegistration(input: { fullName: string; phone: string; email: string; password: string; devicePolicyAccepted: true }, metadata: RequestMetadata) {
  const config = getConfig();
  if (!config.auth.stagedRegistrationEnabled) {
    throw serviceUnavailable("REGISTRATION_DISABLED", "Staged mobile registration is not enabled for this deployment.");
  }

  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  if (!metadata.deviceId || !metadata.deviceSecret || !["ANDROID", "IOS"].includes(metadata.platform ?? "")) {
    throw badRequest("DEVICE_IDENTITY_REQUIRED", "A secure mobile device identity is required to create this account.");
  }
  const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true, phone: true, status: true, deletedAt: true, role: { select: { key: true } }, passwordCredential: { select: { userId: true } } } });
  if (hasBlockingExistingAccount(existingUser)) throw conflict("EMAIL_ALREADY_REGISTERED", "An account already exists for this email address.");
  if (existingUser?.phone && normalizePhone(existingUser.phone) !== phone) throw conflict("IMPORTED_ACCOUNT_PHONE_MISMATCH", "Use the mobile number registered by your Academy to activate this account.");

  const passwordHash = await hashPassword(input.password);
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  const emailCode = newOtp();
  const registrationId = randomUUID();
  const challenge = await prisma.$transaction(async (transaction) => {
    await transaction.registrationChallenge.updateMany({
      where: { email, completedAt: null, cancelledAt: null },
      data: { cancelledAt: new Date(), passwordHash: null, emailOtpHash: null, mobileOtpHash: null },
    });
    const created = await transaction.registrationChallenge.create({
      data: {
        id: registrationId,
        email, phone, fullName: input.fullName.trim(), passwordHash, expiresAt,
        ...deviceHashes(metadata),
        deviceName: metadata.deviceName?.slice(0, 128), platform: metadata.platform,
        devicePolicyAcceptedAt: new Date(),
        emailOtpHash: otpHash(registrationId, "email", emailCode), emailSentAt: new Date(),
      },
    });
    return created;
  });
  let delivery: { developmentCode?: string };
  try {
    delivery = await deliverOtp(challenge, "email", emailCode);
  } catch (error) {
    await prisma.registrationChallenge.update({
      where: { id: challenge.id },
      data: { cancelledAt: new Date(), passwordHash: null, emailOtpHash: null, mobileOtpHash: null },
    });
    throw error;
  }
  return {
    registrationId: challenge.id,
    email: { masked: maskEmail(email), status: "PENDING" as const, resendAfter: new Date(challenge.emailSentAt!.getTime() + RESEND_COOLDOWN_MS) },
    expiresAt,
    ...delivery,
  };
}

export async function sendRegistrationOtp(registrationId: string, channel: OtpChannel) {
  const challenge = await prisma.registrationChallenge.findUnique({ where: { id: registrationId } });
  if (!challenge) throw notFound("REGISTRATION_NOT_FOUND", "The registration could not be found.");
  assertChallengeUsable(challenge);
  const state = channelState(challenge, channel);
  if (state.verifiedAt) return { channel, status: "VERIFIED" as const };
  if (state.resendCount >= MAX_RESENDS) throw new ApiError(429, "OTP_RESEND_LIMIT_REACHED", "Too many verification codes were requested. Start again later.");
  if (state.sentAt && state.sentAt.getTime() + RESEND_COOLDOWN_MS > Date.now()) {
    throw new ApiError(429, "OTP_RESEND_TOO_SOON", "Wait before requesting another verification code.");
  }

  const code = newOtp();
  const codeHash = otpHash(registrationId, channel, code);
  const sentAt = new Date();
  const data = { emailOtpHash: codeHash, emailSentAt: sentAt, emailAttempts: 0, emailResendCount: { increment: 1 } };
  const updated = await prisma.registrationChallenge.update({ where: { id: registrationId }, data });
  let delivery: { developmentCode?: string };
  try {
    delivery = await deliverOtp(updated, channel, code);
  } catch (error) {
    await prisma.registrationChallenge.updateMany({
      where: { id: registrationId, emailOtpHash: codeHash },
      data: { emailOtpHash: null, emailSentAt: null, emailResendCount: { decrement: 1 } },
    });
    throw error;
  }
  return { channel, status: "PENDING" as const, resendAfter: new Date(sentAt.getTime() + RESEND_COOLDOWN_MS), ...delivery };
}

export async function verifyRegistrationOtp(registrationId: string, channel: OtpChannel, code: string) {
  const challenge = await prisma.registrationChallenge.findUnique({ where: { id: registrationId } });
  if (!challenge) throw notFound("REGISTRATION_NOT_FOUND", "The registration could not be found.");
  assertChallengeUsable(challenge);
  const state = channelState(challenge, channel);
  if (state.verifiedAt) return { channel, status: "VERIFIED" as const, nextStep: "COMPLETE" as const };
  if (!state.hash || state.hash === "pending") throw badRequest("OTP_NOT_SENT", "Request a verification code first.");
  if (state.attempts >= MAX_ATTEMPTS) throw new ApiError(429, "OTP_ATTEMPT_LIMIT_REACHED", "Too many incorrect codes were entered. Request a new code.");

  const valid = otpMatches(state.hash, otpHash(registrationId, channel, code));
  if (!valid) {
    await prisma.registrationChallenge.update({ where: { id: registrationId }, data: { emailAttempts: { increment: 1 } } });
    throw badRequest("OTP_INCORRECT", "The verification code is incorrect.");
  }

  const verifiedAt = new Date();
  await prisma.registrationChallenge.update({ where: { id: registrationId }, data: { emailVerifiedAt: verifiedAt, emailOtpHash: null } });
  return { channel, status: "VERIFIED" as const, nextStep: "COMPLETE" as const };
}

export async function completeRegistration(registrationId: string, metadata: RequestMetadata, admissionProof?: string): Promise<AuthResult> {
  const challenge = await prisma.registrationChallenge.findUnique({ where: { id: registrationId } });
  if (!challenge) throw notFound("REGISTRATION_NOT_FOUND", "The registration could not be found.");
  assertChallengeUsable(challenge);
  if (!challenge.emailVerifiedAt || !challenge.passwordHash) {
    throw conflict("REGISTRATION_VERIFICATION_INCOMPLETE", "Verify the email address before completing registration.");
  }
  if (!challenge.devicePolicyAcceptedAt || !challenge.deviceIdHash || !challenge.deviceSecretHash) {
    throw conflict("DEVICE_POLICY_REQUIRED", "Accept the single-device access policy before completing registration.");
  }
  const { deviceIdHash: requestDeviceIdHash, deviceSecretHash: requestDeviceSecretHash } = deviceHashes(metadata);
  if (requestDeviceIdHash !== challenge.deviceIdHash || requestDeviceSecretHash !== challenge.deviceSecretHash) {
    throw conflict("REGISTRATION_DEVICE_CHANGED", "Complete registration on the same device where it was started.");
  }

  try {
    const user = await prisma.$transaction(async (transaction) => {
      const claimed = await transaction.registrationChallenge.updateMany({
        where: { id: registrationId, completedAt: null, cancelledAt: null },
        data: { completedAt: new Date(), passwordHash: null, emailOtpHash: null, mobileOtpHash: null },
      });
      if (claimed.count !== 1) throw conflict("REGISTRATION_ALREADY_COMPLETED", "This registration has already been completed.");
      const role = await transaction.role.findUnique({ where: { key: "student" }, select: { id: true, isActive: true } });
      if (!role?.isActive) throw serviceUnavailable("IDENTITY_CONFIGURATION_ERROR", "The student role is not available.");
      const existing = await transaction.user.findUnique({ where: { email: challenge.email }, include: { passwordCredential: { select: { userId: true } }, role: { select: { key: true } } } });
      if (existing?.passwordCredential || (existing && existing.role.key !== "student")) throw conflict("EMAIL_ALREADY_REGISTERED", "An account already exists for this email address.");
      const isNewAccount = !existing;
      const user = existing
        ? await transaction.user.update({
            where: { id: existing.id },
            data: { fullName: challenge.fullName, phone: challenge.phone, passwordCredential: { create: { passwordHash: challenge.passwordHash! } } },
            include: { role: { select: { key: true, isActive: true, rolePermissions: { select: { permission: { select: { key: true } } } } } } },
          })
        : await transaction.user.create({
            data: { id: randomUUID(), email: challenge.email, fullName: challenge.fullName, phone: challenge.phone, roleId: role.id, passwordCredential: { create: { passwordHash: challenge.passwordHash! } } },
            include: { role: { select: { key: true, isActive: true, rolePermissions: { select: { permission: { select: { key: true } } } } } } },
          });
      const admission = admissionProof
        ? await redeemAdmissionProof(transaction, { id: user.id, email: user.email, fullName: user.fullName }, admissionProof)
        : null;
      await transaction.studentDeviceBinding.upsert({
        where: { userId: user.id },
        create: { userId: user.id, deviceIdHash: challenge.deviceIdHash!, deviceSecretHash: challenge.deviceSecretHash!, deviceName: challenge.deviceName, platform: challenge.platform },
        update: { deviceIdHash: challenge.deviceIdHash!, deviceSecretHash: challenge.deviceSecretHash!, deviceName: challenge.deviceName, platform: challenge.platform, lastVerifiedAt: new Date() },
      });
      if (isNewAccount) {
        await enqueueAccountCreatedEmail(transaction, {
          userId: user.id,
          recipientEmail: user.email,
          userName: user.fullName,
          accountCreatedAt: user.createdAt.toISOString(),
          ...(admission?.academyId ? { academyId: admission.academyId } : {}),
        });
      }
      return user;
    });
    return createSession(user, metadata);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw conflict("EMAIL_ALREADY_REGISTERED", "An account already exists for this email address.");
    }
    throw error;
  }
}
