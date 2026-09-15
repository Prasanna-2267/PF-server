import type { NextFunction, Request, Response } from "express";
import type { AcademyMemberRole } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { badRequest, conflict, forbidden, unauthorized } from "../errors/api-error.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  roleKey: string;
}

export interface TenantContext {
  user: AuthenticatedUser;
  academyId: string | null;
  roleInAcademy: AcademyMemberRole | null;
  membershipId: string | null;
  permissions: ReadonlySet<string>;
  isSuperAdmin: boolean;
}

export type TenantRequest = Request;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const academyPermissions = (role: AcademyMemberRole): ReadonlySet<string> => {
  if (role === "ACADEMY_ADMIN") return new Set(["academy:manage", "academy:read"]);
  if (role === "ACADEMY_TEACHER") return new Set(["academy:read", "academy:teaching:manage"]);
  return new Set(["academy:read:self"]);
};

const requestedAcademyCandidate = (req: Request): string | undefined => {
  const candidate = req.get("x-academy-id")?.trim();
  if (!candidate) return undefined;
  if (!UUID.test(candidate)) throw badRequest("INVALID_ACADEMY_CONTEXT", "x-academy-id must contain a valid academy UUID.");
  return candidate;
};

const requestedAcademyValues = (req: Request): string[] => {
  const values: unknown[] = [req.params.academyId, req.query.academyId];
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    values.push((req.body as Record<string, unknown>).academyId);
  }
  return values.flatMap((value) => Array.isArray(value) ? value : [value]).filter((value): value is string => typeof value === "string" && value.length > 0);
};

const assertNoAcademySpoofing = (req: Request, authorizedAcademyId: string): void => {
  if (requestedAcademyValues(req).some((academyId) => academyId !== authorizedAcademyId)) {
    throw forbidden("CROSS_TENANT_ACCESS_DENIED", "The requested resource is outside the authorized academy context.");
  }
};

export async function resolveTenantContext(req: TenantRequest): Promise<TenantContext> {
  if (!req.auth) throw unauthorized();
  const candidate = requestedAcademyCandidate(req);
  const isSuperAdmin = req.auth.roleKey === "super_admin";

  if (isSuperAdmin) {
    if (!candidate) throw conflict("ACADEMY_SELECTION_REQUIRED", "Super Admin academy operations require an explicit x-academy-id selection.");
    const targetAcademyId = candidate;
    const academy = await prisma.academy.findFirst({
      where: { id: targetAcademyId, status: "ACTIVE", deletedAt: null },
      select: { id: true },
    });
    if (!academy) throw forbidden("ACADEMY_UNAVAILABLE", "The selected academy is unavailable.");
    assertNoAcademySpoofing(req, academy.id);
    return {
      user: { id: req.auth.userId, email: req.auth.email, fullName: req.auth.fullName, roleKey: req.auth.roleKey },
      academyId: academy.id,
      roleInAcademy: null,
      membershipId: null,
      permissions: new Set(["academy:read"]),
      isSuperAdmin: true,
    };
  }

  const memberships = await prisma.academyMembership.findMany({
    where: {
      userId: req.auth.userId,
      status: "ACTIVE",
      ...(["ACADEMY_ADMIN", "academy_admin"].includes(req.auth.roleKey) ? { role: "ACADEMY_ADMIN" as const } : {}),
      academy: { status: "ACTIVE", deletedAt: null },
    },
    select: { id: true, academyId: true, role: true },
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
    take: 2,
  });

  if (memberships.length === 0) {
    throw forbidden("ACADEMY_MEMBERSHIP_REQUIRED", "An active academy membership is required.");
  }
  if (memberships.length > 1) {
    throw conflict("ACADEMY_ADMIN_SINGLE_TENANT_REQUIRED", "Academy Admin accounts must have exactly one active academy membership.");
  }

  const membership = memberships[0]!;
  if (candidate && candidate !== membership.academyId) {
    throw forbidden("CROSS_TENANT_ACCESS_DENIED", "The requested resource is outside the authorized academy context.");
  }
  assertNoAcademySpoofing(req, membership.academyId);
  return {
    user: { id: req.auth.userId, email: req.auth.email, fullName: req.auth.fullName, roleKey: req.auth.roleKey },
    academyId: membership.academyId,
    roleInAcademy: membership.role,
    membershipId: membership.id,
    permissions: academyPermissions(membership.role),
    isSuperAdmin: false,
  };
}

export async function requireTenantContext(req: TenantRequest, _res: Response, next: NextFunction): Promise<void> {
  try {
    req.tenantContext = await resolveTenantContext(req);
    next();
  } catch (error) {
    next(error);
  }
}

export async function requireAcademyAdminMiddleware(req: TenantRequest, _res: Response, next: NextFunction): Promise<void> {
  try {
    const context = req.tenantContext ?? await resolveTenantContext(req);
    req.tenantContext = context;
    if (context.isSuperAdmin) {
      throw forbidden("ACADEMY_ADMIN_REQUIRED", "Super Admin academy inspection is read-only. Use the platform academy detail APIs.");
    }
    if (!req.auth || !["ACADEMY_ADMIN", "academy_admin"].includes(req.auth.roleKey) || context.roleInAcademy !== "ACADEMY_ADMIN") {
      throw forbidden("ACADEMY_ADMIN_REQUIRED", "An active Academy Admin membership is required.");
    }
    next();
  } catch (error) {
    next(error);
  }
}

export function assertTenantResourceAccess(context: TenantContext, resourceAcademyId: string): void {
  if (context.isSuperAdmin) return;
  if (!context.academyId || context.academyId !== resourceAcademyId) {
    throw forbidden("CROSS_TENANT_ACCESS_DENIED", "The requested resource belongs to another academy.");
  }
}
