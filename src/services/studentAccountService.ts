import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { AccountVerificationPurpose, LearnerTheme } from "../../generated/prisma/client.js";
import { getConfig } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { ApiError, badRequest, conflict, forbidden, notFound, serviceUnavailable } from "../errors/api-error.js";
import { getEmailProvider } from "../integrations/provider-registry.js";
import { patchPreferences } from "./learnerPreferenceService.js";
import { enqueueUserLifecycleEmail } from "./userLifecycleEmailService.js";
import { hashPassword, verifyPassword } from "../auth/password.js";

const TTL_MS = 15 * 60_000;
const RESEND_COOLDOWN_MS = 30_000;
const MAX_ATTEMPTS = 5;
const MAX_RESENDS = 5;

const normalizeEmail = (value: string) => value.trim().toLowerCase();
const normalizePhone = (value: string) => {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  const normalized = trimmed.startsWith("+") ? `+${digits}` : digits.length === 10 ? `+91${digits}` : `+${digits}`;
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw badRequest("INVALID_PHONE", "Enter a valid mobile number including its country code.");
  return normalized;
};
const otpHash = (id: string, code: string) => createHmac("sha256", getConfig().auth.jwtSecret).update(`account:${id}:${code}`).digest("hex");
const otpMatches = (left: string, right: string) => {
  const a = Buffer.from(left, "hex"); const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};
const newCode = () => randomInt(0, 10_000).toString().padStart(4, "0");
const maskedEmail = (target: string) => target.replace(/^(.{2}).*(@.*)$/, "$1***$2");

async function activeUser(userId: string) {
  const user = await prisma.user.findFirst({ where: { id: userId, status: "ACTIVE", deletedAt: null }, select: { id: true, email: true, phone: true, fullName: true } });
  if (!user) throw notFound("USER_NOT_FOUND", "The current account was not found.");
  return user;
}

export async function getStudentAccount(userId: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, status: "ACTIVE", deletedAt: null },
    select: {
      id: true,
      email: true,
      fullName: true,
      phone: true,
      createdAt: true,
      learnerPreference: { include: { selectedCourse: { select: { id: true, code: true, name: true, slug: true } } } },
      learnerNotificationPreference: true,
      activeAcademyPreference: {
        include: { academy: { select: { id: true, name: true, slug: true, logoUrl: true, city: true, state: true } } },
      },
      academyMemberships: {
        where: { role: "ACADEMY_STUDENT", status: "ACTIVE", academy: { status: "ACTIVE", deletedAt: null } },
        orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
        take: 1,
        select: { academy: { select: { id: true, name: true, slug: true, logoUrl: true, city: true, state: true } } },
      },
    },
  });
  if (!user) throw notFound("USER_NOT_FOUND", "The current account was not found.");
  const { activeAcademyPreference, academyMemberships, ...account } = user;
  return {
    ...account,
    activeAcademy: activeAcademyPreference?.academy ?? academyMemberships[0]?.academy ?? null,
  };
}

export async function updateName(userId: string, fullName: string) {
  await activeUser(userId);
  return prisma.user.update({ where: { id: userId }, data: { fullName: fullName.trim() }, select: { id: true, fullName: true, email: true, phone: true, updatedAt: true } });
}

export async function changePassword(userId: string, currentSessionId: string, currentPassword: string, newPassword: string) {
  const account = await prisma.user.findFirst({
    where: { id: userId, status: "ACTIVE", deletedAt: null },
    select: { email: true, fullName: true, passwordCredential: { select: { passwordHash: true } } },
  });
  if (!account?.passwordCredential) throw notFound("PASSWORD_CREDENTIAL_NOT_FOUND", "This account does not have a password credential.");
  if (!(await verifyPassword(currentPassword, account.passwordCredential.passwordHash))) throw badRequest("CURRENT_PASSWORD_INCORRECT", "The current password is incorrect.");
  if (await verifyPassword(newPassword, account.passwordCredential.passwordHash)) throw conflict("PASSWORD_UNCHANGED", "Choose a password different from your current password.");
  const passwordHash = await hashPassword(newPassword);
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.passwordCredential.update({ where: { userId }, data: { passwordHash, passwordChangedAt: now } });
    await tx.userSession.updateMany({ where: { userId, id: { not: currentSessionId }, revokedAt: null }, data: { revokedAt: now, refreshTokenHash: null } });
    const event = await tx.securityEvent.create({ data: { eventType: "PASSWORD_CHANGED", riskLevel: "MEDIUM", description: "The learner changed their account password.", userId, actorId: userId, sessionId: currentSessionId } });
    await enqueueUserLifecycleEmail(tx, { deduplicationKey: `password-changed:${event.id}`, recipientEmail: account.email, userName: account.fullName, event: "PASSWORD_CHANGED", occurredAt: now.toISOString() });
    return { changed: true, otherSessionsRevoked: true };
  });
}

async function deliver(challenge: { id: string; purpose: AccountVerificationPurpose; targetValue: string }, fullName: string, accountEmail: string, code: string) {
  const config = getConfig();
  if (config.environment !== "production") {
    const configured = config.email.driver === "smtp" || Boolean(config.email.webhookUrl);
    if (!configured) return { developmentCode: code };
  }
  try {
    const recipient = challenge.purpose === "MOBILE_CHANGE" ? accountEmail : challenge.targetValue;
    const template = challenge.purpose === "DELETE_ACCOUNT"
      ? "account-delete-otp"
      : challenge.purpose === "MOBILE_CHANGE"
        ? "account-mobile-change-otp"
        : "account-email-change-otp";
    await getEmailProvider().send({ to: recipient, template, variables: { name: fullName, code, expiresInMinutes: "15" }, idempotencyKey: `account:${challenge.id}:${otpHash(challenge.id, code).slice(0, 16)}` });
    return {};
  } catch {
    throw serviceUnavailable("OTP_DELIVERY_UNAVAILABLE", "The verification code could not be delivered. Try again.");
  }
}

async function deliverEmailChangeCode(challengeId: string, fullName: string, recipientEmail: string, code: string) {
  const config = getConfig();
  if (config.environment !== "production") {
    const configured = config.email.driver === "smtp" || Boolean(config.email.webhookUrl);
    if (!configured) return { developmentCode: code };
  }
  try {
    await getEmailProvider().send({
      to: recipientEmail,
      template: "account-email-change-otp",
      variables: { name: fullName, code, expiresInMinutes: "15" },
      idempotencyKey: `account:${challengeId}:${otpHash(challengeId, code).slice(0, 16)}`,
    });
    return {};
  } catch {
    throw serviceUnavailable("OTP_DELIVERY_UNAVAILABLE", "The verification code could not be delivered. Try again.");
  }
}

async function emailChangeChallenge(userId: string, challengeId: string) {
  const challenge = await prisma.accountVerificationChallenge.findFirst({ where: { id: challengeId, userId, purpose: "EMAIL_CHANGE" } });
  if (!challenge) throw notFound("ACCOUNT_CHALLENGE_NOT_FOUND", "The email-change verification request was not found.");
  if (challenge.consumedAt) throw conflict("OTP_ALREADY_USED", "This verification code has already been used.");
  if (challenge.cancelledAt) throw new ApiError(410, "OTP_REPLACED", "This verification request was replaced by a newer one.");
  if (challenge.expiresAt <= new Date()) throw new ApiError(410, "OTP_EXPIRED", "This verification code has expired.");
  if (!challenge.previousValue) throw conflict("DUAL_EMAIL_VERIFICATION_REQUIRED", "Start a new email change and verify both email addresses.");
  return challenge;
}

async function assertEmailChangeCode(userId: string, challengeId: string, code: string) {
  const challenge = await emailChangeChallenge(userId, challengeId);
  if (!challenge.otpHash) throw badRequest("OTP_NOT_SENT", "Request a verification code first.");
  if (challenge.attempts >= MAX_ATTEMPTS) throw new ApiError(429, "OTP_ATTEMPT_LIMIT_REACHED", "Too many incorrect codes were entered.");
  if (!otpMatches(challenge.otpHash, otpHash(challenge.id, code))) {
    await prisma.accountVerificationChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
    throw badRequest("OTP_INCORRECT", "The verification code is incorrect.");
  }
  return challenge;
}

export async function requestEmailChange(userId: string, rawEmail: string) {
  const user = await activeUser(userId);
  const targetValue = normalizeEmail(rawEmail);
  if (targetValue === user.email) throw conflict("EMAIL_UNCHANGED", "Enter an email different from your current email.");
  if (await prisma.user.findUnique({ where: { email: targetValue }, select: { id: true } })) throw conflict("EMAIL_ALREADY_REGISTERED", "An account already uses this email address.");
  const previous = await prisma.accountVerificationChallenge.findFirst({ where: { userId, purpose: "EMAIL_CHANGE", consumedAt: null, cancelledAt: null }, orderBy: { createdAt: "desc" } });
  if (previous?.sentAt && previous.sentAt.getTime() + RESEND_COOLDOWN_MS > Date.now()) throw new ApiError(429, "OTP_RESEND_TOO_SOON", "Wait before requesting another verification code.");
  if (previous && previous.resendCount >= MAX_RESENDS) throw new ApiError(429, "OTP_RESEND_LIMIT_REACHED", "Too many verification codes were requested. Try again later.");
  const id = randomUUID(); const code = newCode(); const now = new Date();
  const challenge = await prisma.$transaction(async (tx) => {
    await tx.accountVerificationChallenge.updateMany({ where: { userId, purpose: "EMAIL_CHANGE", consumedAt: null, cancelledAt: null }, data: { cancelledAt: now, otpHash: null } });
    return tx.accountVerificationChallenge.create({ data: { id, userId, purpose: "EMAIL_CHANGE", targetValue, previousValue: user.email, otpHash: otpHash(id, code), sentAt: now, resendCount: 1, expiresAt: new Date(now.getTime() + TTL_MS) } });
  });
  try {
    const delivery = await deliverEmailChangeCode(challenge.id, user.fullName, user.email, code);
    return { challengeId: challenge.id, purpose: "EMAIL_CHANGE" as const, stage: "CURRENT_EMAIL" as const, maskedTarget: maskedEmail(user.email), expiresAt: challenge.expiresAt, resendAfter: new Date(now.getTime() + RESEND_COOLDOWN_MS), ...delivery };
  } catch (error) {
    await prisma.accountVerificationChallenge.update({ where: { id }, data: { cancelledAt: new Date(), otpHash: null } });
    throw error;
  }
}

export async function verifyCurrentEmailForChange(userId: string, challengeId: string, code: string) {
  const challenge = await assertEmailChangeCode(userId, challengeId, code);
  if (challenge.currentVerifiedAt) throw conflict("CURRENT_EMAIL_ALREADY_VERIFIED", "The current email is already verified. Verify the replacement email.");
  const user = await activeUser(userId);
  if (user.email !== challenge.previousValue) throw conflict("EMAIL_CHANGED", "The current account email changed. Start the email-change process again.");
  const nextCode = newCode(); const now = new Date();
  const claimed = await prisma.accountVerificationChallenge.updateMany({
    where: { id: challenge.id, userId, purpose: "EMAIL_CHANGE", currentVerifiedAt: null, consumedAt: null, cancelledAt: null, otpHash: challenge.otpHash },
    data: { currentVerifiedAt: now, otpHash: otpHash(challenge.id, nextCode), attempts: 0, sentAt: now, resendCount: { increment: 1 }, expiresAt: new Date(now.getTime() + TTL_MS) },
  });
  if (claimed.count !== 1) throw conflict("CURRENT_EMAIL_ALREADY_VERIFIED", "The current email was already verified. Use the latest code sent to the replacement email.");
  try {
    const delivery = await deliverEmailChangeCode(challenge.id, user.fullName, challenge.targetValue, nextCode);
    return { challengeId: challenge.id, purpose: "EMAIL_CHANGE" as const, stage: "NEW_EMAIL" as const, maskedTarget: maskedEmail(challenge.targetValue), expiresAt: new Date(now.getTime() + TTL_MS), resendAfter: new Date(now.getTime() + RESEND_COOLDOWN_MS), ...delivery };
  } catch (error) {
    await prisma.accountVerificationChallenge.update({ where: { id: challenge.id }, data: { cancelledAt: new Date(), otpHash: null } });
    throw error;
  }
}

export async function resendEmailChangeCode(userId: string, challengeId: string) {
  const challenge = await emailChangeChallenge(userId, challengeId);
  if (challenge.sentAt && challenge.sentAt.getTime() + RESEND_COOLDOWN_MS > Date.now()) throw new ApiError(429, "OTP_RESEND_TOO_SOON", "Wait before requesting another verification code.");
  if (challenge.resendCount >= MAX_RESENDS) throw new ApiError(429, "OTP_RESEND_LIMIT_REACHED", "Too many verification codes were requested. Start again later.");
  const user = await activeUser(userId);
  if (user.email !== challenge.previousValue) throw conflict("EMAIL_CHANGED", "The current account email changed. Start the email-change process again.");
  const code = newCode(); const now = new Date();
  const recipient = challenge.currentVerifiedAt ? challenge.targetValue : challenge.previousValue;
  const rotated = await prisma.accountVerificationChallenge.updateMany({
    where: { id: challenge.id, userId, consumedAt: null, cancelledAt: null, sentAt: challenge.sentAt, resendCount: challenge.resendCount },
    data: { otpHash: otpHash(challenge.id, code), attempts: 0, sentAt: now, resendCount: { increment: 1 }, expiresAt: new Date(now.getTime() + TTL_MS) },
  });
  if (rotated.count !== 1) throw conflict("OTP_REPLACED", "A newer verification code was already requested.");
  try {
    const delivery = await deliverEmailChangeCode(challenge.id, user.fullName, recipient, code);
    return { challengeId: challenge.id, purpose: "EMAIL_CHANGE" as const, stage: challenge.currentVerifiedAt ? "NEW_EMAIL" as const : "CURRENT_EMAIL" as const, maskedTarget: maskedEmail(recipient), expiresAt: new Date(now.getTime() + TTL_MS), resendAfter: new Date(now.getTime() + RESEND_COOLDOWN_MS), ...delivery };
  } catch (error) {
    await prisma.accountVerificationChallenge.updateMany({ where: { id: challenge.id, otpHash: otpHash(challenge.id, code), consumedAt: null }, data: { cancelledAt: new Date(), otpHash: null } });
    throw error;
  }
}

export async function confirmEmailChange(userId: string, challengeId: string, code: string) {
  const challenge = await assertEmailChangeCode(userId, challengeId, code);
  if (!challenge.currentVerifiedAt) throw forbidden("CURRENT_EMAIL_VERIFICATION_REQUIRED", "Verify the current email before verifying the replacement email.");
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const current = await tx.user.findFirst({ where: { id: userId, status: "ACTIVE", deletedAt: null }, select: { email: true, phone: true, fullName: true } });
    if (!current || current.email !== challenge.previousValue) throw conflict("EMAIL_CHANGED", "The current account email changed. Start the email-change process again.");
    const duplicate = await tx.user.findUnique({ where: { email: challenge.targetValue }, select: { id: true } });
    if (duplicate && duplicate.id !== userId) throw conflict("EMAIL_ALREADY_REGISTERED", "An account already uses this email address.");
    const claimed = await tx.accountVerificationChallenge.updateMany({ where: { id: challenge.id, userId, purpose: "EMAIL_CHANGE", currentVerifiedAt: { not: null }, consumedAt: null, cancelledAt: null }, data: { consumedAt: now, otpHash: null } });
    if (claimed.count !== 1) throw conflict("OTP_ALREADY_USED", "This verification code has already been used.");
    const user = await tx.user.update({ where: { id: userId }, data: { email: challenge.targetValue }, select: { id: true, fullName: true, email: true, phone: true } });
    await tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, refreshTokenHash: null } });
    await enqueueUserLifecycleEmail(tx, { deduplicationKey: `email-changed:old:${challenge.id}`, recipientEmail: current.email, userName: current.fullName, event: "EMAIL_CHANGED_OLD", occurredAt: now.toISOString(), details: { newEmail: challenge.targetValue } });
    await enqueueUserLifecycleEmail(tx, { deduplicationKey: `email-changed:new:${challenge.id}`, recipientEmail: challenge.targetValue, userName: current.fullName, event: "EMAIL_CHANGED_NEW", occurredAt: now.toISOString(), details: { oldEmail: current.email } });
    return { user, signedOut: true };
  });
}

export async function requestVerification(userId: string, purpose: AccountVerificationPurpose, rawTarget?: string) {
  if (purpose === "EMAIL_CHANGE") return requestEmailChange(userId, rawTarget ?? "");
  const user = await activeUser(userId);
  const targetValue = purpose === "MOBILE_CHANGE" ? normalizePhone(rawTarget ?? "") : user.email;
  if (purpose === "MOBILE_CHANGE") {
    if (targetValue === user.phone) throw conflict("MOBILE_UNCHANGED", "Enter a mobile number different from your current number.");
    if (await prisma.user.findFirst({ where: { phone: targetValue, deletedAt: null }, select: { id: true } })) throw conflict("MOBILE_ALREADY_REGISTERED", "An account already uses this mobile number.");
  }
  const previous = await prisma.accountVerificationChallenge.findFirst({ where: { userId, purpose, consumedAt: null, cancelledAt: null }, orderBy: { createdAt: "desc" } });
  if (previous?.sentAt && previous.sentAt.getTime() + RESEND_COOLDOWN_MS > Date.now()) throw new ApiError(429, "OTP_RESEND_TOO_SOON", "Wait before requesting another verification code.");
  if (previous && previous.resendCount >= MAX_RESENDS) throw new ApiError(429, "OTP_RESEND_LIMIT_REACHED", "Too many verification codes were requested. Try again later.");
  const id = randomUUID(); const code = newCode(); const now = new Date();
  const challenge = await prisma.$transaction(async (tx) => {
    await tx.accountVerificationChallenge.updateMany({ where: { userId, purpose, consumedAt: null, cancelledAt: null }, data: { cancelledAt: now, otpHash: null } });
    return tx.accountVerificationChallenge.create({ data: { id, userId, purpose, targetValue, otpHash: otpHash(id, code), sentAt: now, resendCount: (previous?.resendCount ?? 0) + 1, expiresAt: new Date(now.getTime() + TTL_MS) } });
  });
  try {
    const delivery = await deliver(challenge, user.fullName, user.email, code);
    return { challengeId: challenge.id, purpose, maskedTarget: maskedEmail(user.email), expiresAt: challenge.expiresAt, resendAfter: new Date(now.getTime() + RESEND_COOLDOWN_MS), ...delivery };
  } catch (error) {
    await prisma.accountVerificationChallenge.update({ where: { id }, data: { cancelledAt: new Date(), otpHash: null } });
    throw error;
  }
}

export async function verifyChange(userId: string, challengeId: string, purpose: AccountVerificationPurpose, code: string) {
  if (purpose === "EMAIL_CHANGE") throw forbidden("DUAL_EMAIL_VERIFICATION_REQUIRED", "Email changes require verification of both the current and replacement email addresses.");
  const challenge = await prisma.accountVerificationChallenge.findFirst({ where: { id: challengeId, userId, purpose } });
  if (!challenge) throw notFound("ACCOUNT_CHALLENGE_NOT_FOUND", "The verification request was not found.");
  if (challenge.consumedAt) throw conflict("OTP_ALREADY_USED", "This verification code has already been used.");
  if (challenge.cancelledAt) throw new ApiError(410, "OTP_REPLACED", "This verification request was replaced by a newer one.");
  if (challenge.expiresAt <= new Date()) throw new ApiError(410, "OTP_EXPIRED", "This verification code has expired.");
  if (!challenge.otpHash) throw badRequest("OTP_NOT_SENT", "Request a verification code first.");
  if (challenge.attempts >= MAX_ATTEMPTS) throw new ApiError(429, "OTP_ATTEMPT_LIMIT_REACHED", "Too many incorrect codes were entered.");
  if (!otpMatches(challenge.otpHash, otpHash(challenge.id, code))) {
    await prisma.accountVerificationChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
    throw badRequest("OTP_INCORRECT", "The verification code is incorrect.");
  }
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.accountVerificationChallenge.updateMany({ where: { id: challenge.id, userId, purpose, consumedAt: null, cancelledAt: null }, data: { consumedAt: now, otpHash: null } });
    if (claimed.count !== 1) throw conflict("OTP_ALREADY_USED", "This verification code has already been used.");
    const current = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, phone: true, fullName: true } });
    if (purpose === "DELETE_ACCOUNT") {
      await tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, refreshTokenHash: null } });
      await tx.user.update({ where: { id: userId }, data: { status: "DISABLED", deletedAt: now } });
      await enqueueUserLifecycleEmail(tx, { deduplicationKey: `account-deleted:self:${challenge.id}`, recipientEmail: current.email, userName: current.fullName, event: "ACCOUNT_DELETED", occurredAt: now.toISOString() });
      return { deleted: true, signedOut: true };
    }
    const duplicate = await tx.user.findFirst({ where: { phone: challenge.targetValue, deletedAt: null, NOT: { id: userId } }, select: { id: true } });
    if (duplicate) throw conflict("MOBILE_ALREADY_REGISTERED", "An account already uses this mobile number.");
    const user = await tx.user.update({ where: { id: userId }, data: { phone: challenge.targetValue }, select: { id: true, fullName: true, email: true, phone: true } });
    await enqueueUserLifecycleEmail(tx, { deduplicationKey: `phone-changed:${challenge.id}`, recipientEmail: current.email, userName: current.fullName, event: "PHONE_CHANGED", occurredAt: now.toISOString(), details: { oldPhone: current.phone ?? "Not set", newPhone: challenge.targetValue } });
    return { user, signedOut: false };
  });
}

export async function updateExam(userId: string, input: { examMonth: number; examYear: number; examDay?: number; expectedVersion?: number }) {
  return patchPreferences(userId, input);
}
export async function updateStudyTarget(userId: string, dailyTargetMinutes: number, expectedVersion?: number) {
  return patchPreferences(userId, { dailyTargetMinutes, expectedVersion });
}
export async function updateAppearance(userId: string, preferredTheme: LearnerTheme, expectedVersion?: number) {
  const existing = await prisma.learnerPreference.findUnique({ where: { userId }, select: { version: true } });
  if (!existing) throw conflict("PREFERENCES_NOT_INITIALIZED", "Complete learner personalisation first.");
  if (expectedVersion !== undefined && expectedVersion !== existing.version) throw conflict("STALE_PREFERENCES", "Your preferences changed elsewhere. Reload and try again.");
  return prisma.learnerPreference.update({ where: { userId }, data: { preferredTheme, version: { increment: 1 } }, include: { selectedCourse: { select: { id: true, code: true, name: true, slug: true } } } });
}
