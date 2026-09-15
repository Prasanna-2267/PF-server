import { randomUUID } from "node:crypto";
import { Prisma, UserStatus } from "../../generated/prisma/client.js";
import { hashPassword } from "../auth/password.js";
import { prisma } from "../db/prisma.js";
import { conflict, forbidden, notFound } from "../errors/api-error.js";
import { enqueueAccountCreatedEmail } from "./accountCreatedEmailService.js";
import { enqueueUserLifecycleEmail } from "./userLifecycleEmailService.js";

const ROLE_KEY = "super_admin";

export async function listSuperAdmins() {
  return prisma.user.findMany({
    where: { role: { key: ROLE_KEY }, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, fullName: true, email: true, status: true, createdAt: true, lastLoginAt: true },
  });
}

export async function createSuperAdmin(actorId: string, input: { fullName: string; email: string; password: string }) {
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw conflict("EMAIL_ALREADY_REGISTERED", "An account already uses this email address.");
  const passwordHash = await hashPassword(input.password);
  return prisma.$transaction(async (tx) => {
    const role = await tx.role.findFirst({ where: { key: ROLE_KEY, isActive: true }, select: { id: true } });
    if (!role) throw notFound("SUPER_ADMIN_ROLE_NOT_FOUND", "The active Super Admin role is not configured.");
    const user = await tx.user.create({ data: { id: randomUUID(), fullName, email, roleId: role.id, status: UserStatus.ACTIVE }, select: { id: true, fullName: true, email: true, status: true, createdAt: true, lastLoginAt: true } });
    await tx.passwordCredential.create({ data: { userId: user.id, passwordHash } });
    await tx.systemAuditLog.create({ data: { action: "SUPER_ADMIN_CREATED", entityType: "User", entityId: user.id, actorId, description: `Created Super Admin ${user.email}.`, after: { role: ROLE_KEY, status: user.status, email: user.email } } });
    await enqueueAccountCreatedEmail(tx, { userId: user.id, recipientEmail: user.email, userName: user.fullName, accountCreatedAt: user.createdAt.toISOString() });
    return user;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function deleteSuperAdmin(actorId: string, userId: string) {
  if (actorId === userId) throw forbidden("SELF_DELETE_DENIED", "You cannot delete the Super Admin account currently in use.");
  return prisma.$transaction(async (tx) => {
    const target = await tx.user.findFirst({ where: { id: userId, role: { key: ROLE_KEY }, deletedAt: null }, select: { id: true, email: true, fullName: true, status: true } });
    if (!target) throw notFound("SUPER_ADMIN_NOT_FOUND", "The Super Admin account was not found.");
    if (target.status === UserStatus.ACTIVE) {
      const activeCount = await tx.user.count({ where: { role: { key: ROLE_KEY }, status: UserStatus.ACTIVE, deletedAt: null } });
      if (activeCount <= 1) throw conflict("LAST_SUPER_ADMIN", "The final active Super Admin cannot be deleted.");
    }
    const now = new Date();
    await tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, refreshTokenHash: null } });
    await tx.user.update({ where: { id: userId }, data: { status: UserStatus.DISABLED, deletedAt: now } });
    const audit = await tx.systemAuditLog.create({ data: { action: "SUPER_ADMIN_DELETED", entityType: "User", entityId: userId, actorId, description: `Deleted Super Admin ${target.email}.`, before: { role: ROLE_KEY, status: target.status, email: target.email }, after: { status: UserStatus.DISABLED, deletedAt: now.toISOString() } } });
    await enqueueUserLifecycleEmail(tx, { deduplicationKey: `super-admin-deleted:${audit.id}`, recipientEmail: target.email, userName: target.fullName, event: "ACCOUNT_DELETED", occurredAt: audit.occurredAt.toISOString() });
    return { id: userId, deleted: true };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
