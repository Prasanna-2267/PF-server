import { Prisma, UserStatus } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { conflict, forbidden, notFound } from "../errors/api-error.js";
import { enqueueUserLifecycleEmail } from "../services/userLifecycleEmailService.js";

const SUPER_ADMIN_ROLE_KEY = "super_admin";

export class LastActiveSuperAdminError extends Error {
  constructor() {
    super("The final active Super Admin cannot be disabled or demoted.");
    this.name = "LastActiveSuperAdminError";
  }
}

const assertAnotherActiveSuperAdminExists = async (
  transaction: Prisma.TransactionClient,
): Promise<void> => {
  const superAdminRole = await transaction.role.findUniqueOrThrow({
    where: { key: SUPER_ADMIN_ROLE_KEY },
    select: { id: true },
  });

  const activeSuperAdminCount = await transaction.user.count({
    where: {
      roleId: superAdminRole.id,
      status: UserStatus.ACTIVE,
      deletedAt: null,
    },
  });

  if (activeSuperAdminCount <= 1) {
    throw new LastActiveSuperAdminError();
  }
};

export const changeUserRole = async (actorId: string, userId: string, nextRoleKey: string) =>
  prisma.$transaction(
    async (transaction) => {
      if (actorId === userId && nextRoleKey !== SUPER_ADMIN_ROLE_KEY) throw forbidden("SELF_DEMOTION_DENIED", "A Super Admin cannot demote their own account.");
      const [user, nextRole] = await Promise.all([
        transaction.user.findUniqueOrThrow({
          where: { id: userId },
          select: {
            status: true,
            deletedAt: true,
            role: { select: { key: true } },
          },
        }),
        transaction.role.findUniqueOrThrow({
          where: { key: nextRoleKey },
          select: { id: true, key: true, isActive: true },
        }),
      ]);

      if (!nextRole.isActive) {
        throw new Error("An inactive platform role cannot be assigned.");
      }

      const removesActiveSuperAdmin =
        user.role.key === SUPER_ADMIN_ROLE_KEY &&
        nextRole.key !== SUPER_ADMIN_ROLE_KEY &&
        user.status === UserStatus.ACTIVE &&
        user.deletedAt === null;

      if (removesActiveSuperAdmin) {
        await assertAnotherActiveSuperAdminExists(transaction);
      }

      const updated = await transaction.user.update({
        where: { id: userId },
        data: { roleId: nextRole.id },
      });
      await transaction.systemAuditLog.create({ data: { action: "PLATFORM_ROLE_CHANGED", entityType: "User", entityId: userId, actorId, description: `Changed platform role from ${user.role.key} to ${nextRole.key}.`, before: { role: user.role.key }, after: { role: nextRole.key } } });
      return updated;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

export const changeUserStatus = async (
  actorId: string,
  userId: string,
  nextStatus: UserStatus,
) =>
  prisma.$transaction(
    async (transaction) => {
      if (actorId === userId && nextStatus === UserStatus.DISABLED) throw forbidden("SELF_DISABLE_DENIED", "A Super Admin cannot disable their own account.");
      const user = await transaction.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          status: true,
          deletedAt: true,
          email: true,
          fullName: true,
          role: { select: { key: true } },
        },
      });

      const disablesActiveSuperAdmin =
        user.role.key === SUPER_ADMIN_ROLE_KEY &&
        user.status === UserStatus.ACTIVE &&
        nextStatus === UserStatus.DISABLED &&
        user.deletedAt === null;

      if (disablesActiveSuperAdmin) {
        await assertAnotherActiveSuperAdminExists(transaction);
      }

      if (user.status === nextStatus) return transaction.user.findUniqueOrThrow({ where: { id: userId } });

      const updated = await transaction.user.update({
        where: { id: userId },
        data: { status: nextStatus },
      });
      const audit = await transaction.systemAuditLog.create({ data: { action: nextStatus === UserStatus.ACTIVE ? "ACCOUNT_ENABLED" : "ACCOUNT_DISABLED", entityType: "User", entityId: userId, actorId, description: `Changed platform account status to ${nextStatus}.`, before: { status: user.status }, after: { status: nextStatus } } });
      await enqueueUserLifecycleEmail(transaction, { deduplicationKey: `platform-account-status:${audit.id}`, recipientEmail: user.email, userName: user.fullName, event: nextStatus === UserStatus.ACTIVE ? "ACCOUNT_ENABLED" : "ACCOUNT_DISABLED", occurredAt: audit.occurredAt.toISOString() });
      return updated;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
