import { UserStatus } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { enqueueAccountCreatedEmail } from "../services/accountCreatedEmailService.js";

const SUPABASE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface BootstrapSuperAdminInput {
  authUserId: string;
  email: string;
  fullName: string;
  phone?: string | null;
  avatarStoragePath?: string | null;
}

/**
 * Creates or promotes a Super Admin only from an explicitly supplied Supabase
 * Auth identity. The future caller must verify that identity with the Supabase
 * Admin API before invoking this function.
 */
export const bootstrapSuperAdmin = async (
  input: BootstrapSuperAdminInput,
) => {
  const authUserId = input.authUserId.trim();
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();

  if (!SUPABASE_UUID_PATTERN.test(authUserId)) {
    throw new Error("A valid Supabase Auth user UUID is required.");
  }

  if (!email || !fullName) {
    throw new Error("A verified email and full name are required.");
  }

  return prisma.$transaction(async (transaction) => {
    const superAdminRole = await transaction.role.findUniqueOrThrow({
      where: { key: "super_admin" },
      select: { id: true, isActive: true },
    });

    if (!superAdminRole.isActive) {
      throw new Error("The super_admin role is inactive.");
    }

    const existing = await transaction.user.findUnique({ where: { id: authUserId }, select: { id: true } });
    const user = await transaction.user.upsert({
      where: { id: authUserId },
      update: {
        email,
        fullName,
        phone: input.phone ?? null,
        avatarStoragePath: input.avatarStoragePath ?? null,
        status: UserStatus.ACTIVE,
        roleId: superAdminRole.id,
        deletedAt: null,
      },
      create: {
        id: authUserId,
        email,
        fullName,
        phone: input.phone ?? null,
        avatarStoragePath: input.avatarStoragePath ?? null,
        status: UserStatus.ACTIVE,
        roleId: superAdminRole.id,
      },
    });
    if (!existing) {
      await enqueueAccountCreatedEmail(transaction, {
        userId: user.id,
        recipientEmail: user.email,
        userName: user.fullName,
        accountCreatedAt: user.createdAt.toISOString(),
      });
    }
    return user;
  });
};
