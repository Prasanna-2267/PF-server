import { Prisma } from "../../generated/prisma/client.js";
import type { TenantContext } from "../auth/tenant-auth.js";
import { prisma } from "../db/prisma.js";
import { notFound } from "../errors/api-error.js";
import { enqueueUserLifecycleEmail } from "./userLifecycleEmailService.js";

async function scopedStudent(tx: Prisma.TransactionClient, userId: string, academyId?: string | null) {
  const user = await tx.user.findFirst({ where: { id: userId, deletedAt: null, role: { key: { in: ["student", "STUDENT"] } }, ...(academyId === null ? { academyMemberships: { none: {} } } : academyId ? { academyMemberships: { some: { academyId, role: "ACADEMY_STUDENT" } } } : {}) }, select: { id: true, email: true, fullName: true, status: true } });
  if (!user) throw notFound("STUDENT_NOT_FOUND", "The student was not found in this administrative scope.");
  return user;
}

export async function approveStudentDeviceReset(actorId: string, userId: string, academyId?: string | null) {
  return prisma.$transaction(async (tx) => {
    await scopedStudent(tx, userId, academyId);
    const binding = await tx.studentDeviceBinding.findUnique({ where: { userId } });
    if (!binding) {
      // An unbound (typically imported or web-created) learner does not need a
      // reset token. Their next native login is the first binding and becomes
      // the only approved device. Treat this as a successful, idempotent admin
      // action instead of surfacing a misleading conflict to the operator.
      await tx.systemAuditLog.create({
        data: {
          action: "STUDENT_INITIAL_DEVICE_BINDING_CONFIRMED",
          entityType: "User",
          entityId: userId,
          academyId: academyId ?? undefined,
          actorId,
          description: "Confirmed that the learner has no linked device. The next successful native login will establish the permanent device binding.",
          before: { deviceBound: false },
          after: { nextNativeLoginWillBind: true },
        },
      });
      return {
        userId,
        state: "AWAITING_FIRST_BINDING" as const,
        deviceName: null,
        platform: null,
        resetApprovedAt: null,
        expiresAt: null,
        message: "No device is currently linked. The next successful mobile login will securely link this account to that device.",
      };
    }
    const now = new Date();
    const updated = await tx.studentDeviceBinding.update({ where: { userId }, data: { resetApprovedAt: now, resetApprovedById: actorId, resetConsumedAt: null } });
    const revoked = await tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, refreshTokenHash: null } });
    await tx.systemAuditLog.create({ data: { action: "STUDENT_DEVICE_RESET_APPROVED", entityType: "StudentDeviceBinding", entityId: userId, academyId: academyId ?? undefined, actorId, description: "Approved one future student-device change, revoked current sessions, and blocked the old device from signing in until the approval is consumed.", before: { bindingVersion: binding.bindingVersion }, after: { resetApprovedAt: now.toISOString(), revokedSessions: revoked.count } } });
    return {
      userId,
      state: "RESET_APPROVED" as const,
      deviceName: updated.deviceName,
      platform: updated.platform,
      resetApprovedAt: updated.resetApprovedAt,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000),
      revokedSessions: revoked.count,
      message: `Device change approved. ${revoked.count} active ${revoked.count === 1 ? "session was" : "sessions were"} revoked; the student can now sign in only on the replacement device within seven days.`,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function setStudentAccountStatus(actorId: string, userId: string, status: "ACTIVE" | "DISABLED", academyId?: string | null) {
  return prisma.$transaction(async (tx) => {
    const user = await scopedStudent(tx, userId, academyId);
    if (user.status === status) return { id: user.id, status: user.status };
    const updated = await tx.user.update({ where: { id: userId }, data: { status } });
    if (status === "DISABLED") await tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), refreshTokenHash: null } });
    const audit = await tx.systemAuditLog.create({ data: { action: status === "ACTIVE" ? "ACCOUNT_ENABLED" : "ACCOUNT_DISABLED", entityType: "User", entityId: userId, academyId: academyId ?? undefined, actorId, description: `Changed student account status to ${status}.`, before: { status: user.status }, after: { status } } });
    await enqueueUserLifecycleEmail(tx, { deduplicationKey: `account-status:${audit.id}`, recipientEmail: user.email, userName: user.fullName, event: status === "ACTIVE" ? "ACCOUNT_ENABLED" : "ACCOUNT_DISABLED", occurredAt: audit.occurredAt.toISOString() });
    return { id: updated.id, status: updated.status };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function permanentlyDeleteStudent(actorId: string, userId: string, academyId?: string | null) {
  return prisma.$transaction(async (tx) => {
    const user = await scopedStudent(tx, userId, academyId);
    const now = new Date();
    await enqueueUserLifecycleEmail(tx, { deduplicationKey: `account-deleted:admin:${userId}:${now.toISOString()}`, recipientEmail: user.email, userName: user.fullName, event: "ACCOUNT_DELETED", occurredAt: now.toISOString() });
    // Financial, payment and audit rows remain linked to an anonymised tombstone.
    // Learning state and access are removed transactionally so the account cannot be restored accidentally.
    await tx.userSession.deleteMany({ where: { userId } });
    await tx.passwordCredential.deleteMany({ where: { userId } });
    await tx.studentDeviceBinding.deleteMany({ where: { userId } });
    await tx.practiceSession.deleteMany({ where: { userId } });
    await tx.learnerStudyPlan.deleteMany({ where: { userId } });
    await tx.learnerNoteState.deleteMany({ where: { userId } });
    await tx.noteViewerSession.deleteMany({ where: { userId } });
    await tx.focusSession.deleteMany({ where: { userId } });
    await tx.learnerMonthlyReport.deleteMany({ where: { userId } });
    await tx.rewardWallet.deleteMany({ where: { userId } });
    await tx.learnerStreakState.deleteMany({ where: { userId } });
    await tx.learnerDailyActivity.deleteMany({ where: { userId } });
    await tx.mobilePushToken.deleteMany({ where: { userId } });
    await tx.learnerNotificationPreference.deleteMany({ where: { userId } });
    await tx.learnerNotification.deleteMany({ where: { userId } });
    await tx.learnerPreference.deleteMany({ where: { userId } });
    await tx.userAcademyPreference.deleteMany({ where: { userId } });
    await tx.academyCourseEnrollment.deleteMany({ where: { studentId: userId } });
    await tx.academyMembership.deleteMany({ where: { userId, role: "ACADEMY_STUDENT" } });
    await tx.entitlement.deleteMany({ where: { userId } });
    const anonymisedEmail = `deleted+${userId}@deleted.parallaxflow.invalid`;
    await tx.user.update({ where: { id: userId }, data: { email: anonymisedEmail, fullName: "Deleted learner", phone: null, avatarStoragePath: null, status: "DISABLED", deletedAt: now } });
    await tx.systemAuditLog.create({ data: { action: "STUDENT_PERMANENTLY_DELETED", entityType: "User", entityId: userId, academyId: academyId ?? undefined, actorId, description: "Permanently removed the student's identity, access and learning data while retaining anonymised financial and audit records.", before: { email: user.email, fullName: user.fullName }, after: { email: anonymisedEmail, deletedAt: now.toISOString() } } });
    return { id: userId, deleted: true, deletedAt: now };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}

export const academyScope = (context: TenantContext) => ({ actorId: context.user.id, academyId: context.academyId! });
