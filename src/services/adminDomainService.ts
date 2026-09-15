import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { badRequest, conflict, notFound, serviceUnavailable } from "../errors/api-error.js";
import { enqueueAccountCreatedEmail } from "./accountCreatedEmailService.js";
import type { AcademyProvisioningInput, LegacyAcademyInput } from "../domain/academyProvisioning.js";
import { normalizeAccessDurationPolicy } from "./resourceValidityService.js";

const pagination = (page: number, limit: number, total: number) => ({ page, limit, total, totalPages: Math.ceil(total / limit) });
const normalizeSlug = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
async function audit(tx: Prisma.TransactionClient, actorId: string, action: string, entityType: string, entityId: string, description: string, academyId?: string, before?: Prisma.InputJsonValue, after?: Prisma.InputJsonValue) {
  await tx.systemAuditLog.create({ data: { actorId, action, entityType, entityId, description, academyId, before, after } });
}

export async function getAcademiesSummary() {
  const [
    totalAcademies,
    activeAcademies,
    pendingAcademies,
    suspendedAcademies,
    archivedAcademies,
    totalStudents,
    totalCourses,
  ] = await Promise.all([
    prisma.academy.count({ where: { deletedAt: null } }),
    prisma.academy.count({ where: { status: "ACTIVE", deletedAt: null } }),
    prisma.academy.count({ where: { status: "PENDING", deletedAt: null } }),
    prisma.academy.count({ where: { status: "SUSPENDED", deletedAt: null } }),
    prisma.academy.count({ where: { OR: [{ status: "ARCHIVED" }, { deletedAt: { not: null } }] } }),
    prisma.academyMembership.count({ where: { role: "ACADEMY_STUDENT", status: "ACTIVE" } }),
    prisma.course.count({ where: { deletedAt: null } }),
  ]);

  return {
    totalAcademies,
    activeAcademies,
    pendingAcademies,
    suspendedAcademies,
    archivedAcademies,
    totalStudents,
    totalCourses,
  };
}

export type AcademySortOption = "newest" | "oldest" | "name-asc" | "name-desc" | "students" | "courses";
export type AcademyDetailResource = "students" | "courses" | "content" | "questions" | "broadcasts" | "admissions" | "audit";
export interface AcademyDetailPageInput { page: number; limit: number }

export async function listAcademies(input: {
  page: number;
  limit: number;
  search?: string;
  status?: "ACTIVE" | "PENDING" | "SUSPENDED" | "ARCHIVED" | "ALL";
  sort?: AcademySortOption;
  includeDeleted?: boolean;
}) {
  const where: Prisma.AcademyWhereInput = {};

  if (input.status === "ARCHIVED") {
    where.OR = [{ status: "ARCHIVED" }, { deletedAt: { not: null } }];
  } else {
    if (!input.includeDeleted && input.status !== "ALL") {
      where.deletedAt = null;
    }
    if (input.status && input.status !== "ALL") {
      where.status = input.status;
    }
  }

  if (input.search) {
    const term = input.search.trim();
    where.AND = [
      {
        OR: [
          { name: { contains: term, mode: "insensitive" } },
          { email: { contains: term, mode: "insensitive" } },
          { slug: { contains: term, mode: "insensitive" } },
          { adminName: { contains: term, mode: "insensitive" } },
          { adminEmail: { contains: term, mode: "insensitive" } },
          { phone: { contains: term, mode: "insensitive" } },
          { city: { contains: term, mode: "insensitive" } },
        ],
      },
    ];
  }

  let orderBy: Prisma.AcademyOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];
  if (input.sort === "oldest") {
    orderBy = [{ createdAt: "asc" }, { id: "asc" }];
  } else if (input.sort === "name-asc") {
    orderBy = [{ name: "asc" }];
  } else if (input.sort === "name-desc") {
    orderBy = [{ name: "desc" }];
  }

  const [academies, total] = await Promise.all([
    prisma.academy.findMany({
      where,
      skip: (input.page - 1) * input.limit,
      take: input.limit,
      orderBy,
      include: {
        _count: {
          select: {
            memberships: { where: { role: "ACADEMY_STUDENT" } },
            tenantCourses: { where: { deletedAt: null } },
          },
        },
      },
    }),
    prisma.academy.count({ where }),
  ]);

  // Fetch real relational metrics for each academy
  const academyIds = academies.map((a) => a.id);
  const [studentCounts, courseCounts] = await Promise.all([
    prisma.academyMembership.groupBy({
      by: ["academyId"],
      where: { academyId: { in: academyIds }, role: "ACADEMY_STUDENT" },
      _count: { userId: true },
    }),
    prisma.course.groupBy({
      by: ["academyId"],
      where: { academyId: { in: academyIds }, deletedAt: null },
      _count: { id: true },
    }),
  ]);

  const studentCountMap = new Map(studentCounts.map((sc) => [sc.academyId, sc._count.userId]));
  const courseCountMap = new Map(courseCounts.map((cc) => [cc.academyId, cc.academyId ? cc._count.id : 0]));

  let data = academies.map((academy) => {
    const studentCount = studentCountMap.get(academy.id) ?? academy._count.memberships ?? 0;
    const courseCount = courseCountMap.get(academy.id) ?? academy._count.tenantCourses ?? 0;
    return {
      ...academy,
      studentCount,
      courseCount,
      revenue: Number(academy.revenue),
    };
  });

  if (input.sort === "students") {
    data.sort((a, b) => b.studentCount - a.studentCount);
  } else if (input.sort === "courses") {
    data.sort((a, b) => b.courseCount - a.courseCount);
  }

  return { data, pagination: pagination(input.page, input.limit, total) };
}

/**
 * Returns one authorised, academy-scoped page from the same operational tables
 * used by Academy Admin. This is deliberately a query projection, not a
 * platform-side copy of tenant data.
 */
export async function listAcademyDetailResource(
  academyId: string,
  resource: AcademyDetailResource,
  input: AcademyDetailPageInput,
) {
  const academy = await prisma.academy.findUnique({ where: { id: academyId }, select: { id: true } });
  if (!academy) throw notFound("ACADEMY_NOT_FOUND", "The academy was not found.");

  const pageResult = <T>(data: T[], total: number) => ({ data, pagination: pagination(input.page, input.limit, total) });
  const pageArgs = { skip: (input.page - 1) * input.limit, take: input.limit };

  switch (resource) {
    case "students": {
      const where = { academyId, role: "ACADEMY_STUDENT" as const };
      const [data, total] = await Promise.all([
        prisma.academyMembership.findMany({
          where, ...pageArgs, orderBy: [{ joinedAt: "desc" }, { id: "desc" }],
          include: { user: { select: { id: true, email: true, fullName: true, phone: true, status: true, lastLoginAt: true, createdAt: true } } },
        }),
        prisma.academyMembership.count({ where }),
      ]);
      return pageResult(data, total);
    }
    case "courses": {
      const where = { academyId, deletedAt: null };
      const [data, total] = await Promise.all([
        prisma.course.findMany({
          where, ...pageArgs, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          include: { _count: { select: { enrollments: true, contentItems: { where: { deletedAt: null } }, packages: { where: { deletedAt: null } } } } },
        }),
        prisma.course.count({ where }),
      ]);
      return pageResult(data, total);
    }
    case "content": {
      const where = { deletedAt: null, course: { academyId, deletedAt: null } };
      const [items, total] = await Promise.all([
        prisma.contentItem.findMany({
          where, ...pageArgs, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true, name: true, kind: true, mimeType: true, size: true, status: true, createdAt: true, course: { select: { id: true, name: true } } },
        }),
        prisma.contentItem.count({ where }),
      ]);
      return pageResult(items.map((item) => ({ ...item, size: Number(item.size) })), total);
    }
    case "questions": {
      const where = { academyId, deletedAt: null };
      const [data, total] = await Promise.all([
        prisma.question.findMany({
          where, ...pageArgs, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true, kind: true, status: true, difficulty: true, questionHtml: true, caseHtml: true, createdAt: true, course: { select: { id: true, name: true } } },
        }),
        prisma.question.count({ where }),
      ]);
      return pageResult(data, total);
    }
    case "broadcasts": {
      const where = { academyId, deletedAt: null };
      const [data, total] = await Promise.all([
        prisma.broadcast.findMany({
          where, ...pageArgs, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true, title: true, status: true, priority: true, publishedAt: true, createdAt: true },
        }),
        prisma.broadcast.count({ where }),
      ]);
      return pageResult(data, total);
    }
    case "admissions": {
      const where = { academyId };
      const [data, total] = await Promise.all([
        prisma.admissionRecord.findMany({
          where, ...pageArgs, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            id: true, email: true, studentName: true, method: true, status: true,
            failureReason: true, createdAt: true, completedAt: true,
            student: { select: { id: true, fullName: true, email: true } },
            batch: { select: { id: true, fileName: true } },
          },
        }),
        prisma.admissionRecord.count({ where }),
      ]);
      return pageResult(data, total);
    }
    case "audit": {
      const where = { academyId };
      const [logs, total] = await Promise.all([
        prisma.systemAuditLog.findMany({
          where, ...pageArgs, orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          include: { actor: { select: { id: true, fullName: true, email: true } } },
        }),
        prisma.systemAuditLog.count({ where }),
      ]);
      return pageResult(logs.map((log) => ({ ...log, actor: log.actor ?? undefined })), total);
    }
  }
}

export async function getAcademy(academyId: string) {
  const academy = await prisma.academy.findUnique({
    where: { id: academyId },
    include: {
      profile: true,
      legalProfile: true,
      billingProfile: true,
      commercialProfile: true,
      integrationProfile: true,
      contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      addresses: { orderBy: { kind: "asc" } },
      academicOfferings: { orderBy: [{ category: "asc" }, { program: "asc" }] },
      invitations: { take: 100, orderBy: { createdAt: "desc" } },
      systemAuditLogs: {
        take: 50,
        orderBy: { occurredAt: "desc" },
        include: {
          actor: { select: { id: true, fullName: true, email: true } },
        },
      },
    },
  });

  if (!academy) throw notFound("ACADEMY_NOT_FOUND", "The academy was not found.");

  const [
    admins,
    students,
    tenantCourses,
    studentCount,
    activeStudentCount,
    courseCount,
    publishedCourseCount,
    contentCount,
    publishedContentCount,
    contentItems,
    questionCount,
    questionRows,
    broadcastCount,
    activeBroadcastCount,
    broadcasts,
    packages,
    orders,
    auditLogCount,
  ] = await Promise.all([
    prisma.academyMembership.findMany({
      where: { academyId, role: "ACADEMY_ADMIN" },
      take: 20,
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
      include: { user: { select: { id: true, email: true, fullName: true, phone: true, status: true, lastLoginAt: true, createdAt: true } } },
    }),
    prisma.academyMembership.findMany({
      where: { academyId, role: "ACADEMY_STUDENT" },
      take: 100,
      orderBy: [{ joinedAt: "desc" }, { id: "desc" }],
      include: { user: { select: { id: true, email: true, fullName: true, phone: true, status: true, lastLoginAt: true, createdAt: true } } },
    }),
    prisma.course.findMany({
      where: { academyId, deletedAt: null },
      take: 100,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { _count: { select: { enrollments: true, contentItems: { where: { deletedAt: null } }, packages: { where: { deletedAt: null } } } } },
    }),
    prisma.academyMembership.count({ where: { academyId, role: "ACADEMY_STUDENT" } }),
    prisma.academyMembership.count({ where: { academyId, role: "ACADEMY_STUDENT", status: "ACTIVE", user: { status: "ACTIVE", deletedAt: null } } }),
    prisma.course.count({ where: { academyId, deletedAt: null } }),
    prisma.course.count({ where: { academyId, status: "ACTIVE", deletedAt: null } }),
    prisma.contentItem.count({ where: { deletedAt: null, course: { academyId, deletedAt: null } } }),
    prisma.contentItem.count({ where: { status: "PUBLISHED", deletedAt: null, course: { academyId, deletedAt: null } } }),
    prisma.contentItem.findMany({
      where: { deletedAt: null, course: { academyId, deletedAt: null } },
      take: 100,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, name: true, kind: true, mimeType: true, size: true, status: true, createdAt: true, course: { select: { id: true, name: true } } },
    }),
    prisma.question.count({ where: { academyId, deletedAt: null } }),
    prisma.question.findMany({
      where: { academyId, deletedAt: null },
      take: 100,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, kind: true, status: true, difficulty: true, questionHtml: true, caseHtml: true, createdAt: true, course: { select: { id: true, name: true } } },
    }),
    prisma.broadcast.count({ where: { academyId, deletedAt: null } }),
    prisma.broadcast.count({ where: { academyId, status: "ACTIVE", deletedAt: null } }),
    prisma.broadcast.findMany({
      where: { academyId, deletedAt: null },
      take: 100,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, title: true, status: true, priority: true, publishedAt: true, startAt: true, createdAt: true },
    }),
    prisma.package.findMany({
      where: { course: { academyId }, deletedAt: null },
      take: 100,
      orderBy: { createdAt: "desc" },
      include: { course: { select: { id: true, name: true } }, _count: { select: { items: true } } },
    }),
    prisma.order.findMany({
      where: { course: { academyId } },
      take: 100,
      orderBy: { createdAt: "desc" },
      select: { id: true, orderNumber: true, totalAmount: true, status: true, createdAt: true, user: { select: { fullName: true, email: true } } },
    }),
    prisma.systemAuditLog.count({ where: { academyId } }),
  ]);

  const paidOrders = orders.filter((o) => o.status === "PAID");
  const totalRevenue = paidOrders.reduce((sum, o) => sum + Number(o.totalAmount), 0);
  const primaryAdmin = admins.find((membership) => membership.status === "ACTIVE") ?? admins[0] ?? null;

  return {
    ...academy,
    revenue: Number(academy.revenue) || totalRevenue,
    metrics: {
      studentsCount: studentCount,
      activeStudentsCount: activeStudentCount,
      coursesCount: courseCount,
      publishedCoursesCount: publishedCourseCount,
      contentCount,
      publishedContentCount,
      packagesCount: packages.length,
      questionsCount: questionCount,
      broadcastCount,
      activeBroadcastCount,
      auditLogCount,
      ordersCount: orders.length,
      revenue: totalRevenue,
    },
    administrator: primaryAdmin ? {
      id: primaryAdmin.user.id,
      name: primaryAdmin.user.fullName,
      email: primaryAdmin.user.email,
      phone: primaryAdmin.user.phone,
      identityStatus: primaryAdmin.user.status,
      membershipStatus: primaryAdmin.status,
    } : {
      id: null,
      name: academy.adminName,
      email: academy.adminEmail,
      phone: academy.adminPhone || null,
      identityStatus: null,
      membershipStatus: "INVITED",
    },
    admins,
    students,
    memberships: [...admins, ...students],
    tenantCourses,
    contentItems: contentItems.map((item) => ({ ...item, size: Number(item.size) })),
    questions: questionRows,
    packages,
    orders,
    broadcasts,
  };
}

export type AcademyInput = LegacyAcademyInput;
export async function createAcademy(actorId: string, input: AcademyInput | AcademyProvisioningInput) {
  if ("academy" in input) return createProvisionedAcademy(actorId, input);
  const slug = normalizeSlug(input.slug ?? input.name);
  if (slug.length < 2) throw badRequest("INVALID_ACADEMY_SLUG", "A valid academy slug is required.");
  const adminEmail = input.adminEmail.trim().toLowerCase();
  try {
    return await prisma.$transaction(async (tx) => {
      const academyAdminRole = await tx.role.findFirst({ where: { key: "ACADEMY_ADMIN", isActive: true }, select: { id: true } });
      if (!academyAdminRole) throw serviceUnavailable("IDENTITY_CONFIGURATION_ERROR", "The Academy Admin role is not available.");

      const existingUser = await tx.user.findUnique({
        where: { email: adminEmail },
        select: { id: true, deletedAt: true, role: { select: { key: true } } },
      });
      if (existingUser?.deletedAt) throw conflict("ADMIN_IDENTITY_CONFLICT", "The administrator email belongs to a deleted account.");
      if (existingUser && !["ACADEMY_ADMIN", "admin", "ACADEMY_STUDENT", "student"].includes(existingUser.role.key)) {
        throw conflict("ADMIN_IDENTITY_CONFLICT", "The administrator email already belongs to an incompatible platform identity.");
      }
      if (existingUser && await tx.academyMembership.count({ where: { userId: existingUser.id, status: "ACTIVE" } }) > 0) {
        throw conflict("ADMIN_IDENTITY_CONFLICT", "The administrator identity already has an active academy membership.");
      }

      const academy = await tx.academy.create({
        data: {
          slug, name: input.name.trim(), email: input.email.toLowerCase(), phone: input.phone.trim(),
          address: input.address.trim(), city: input.city.trim(), state: input.state.trim(),
          country: input.country?.trim() ?? "India", postalCode: input.postalCode.trim(),
          website: input.website?.trim() ?? "", description: input.description?.trim() ?? "",
          adminName: input.adminName.trim(), adminEmail, adminPhone: input.adminPhone?.trim() ?? "",
          // A Super Admin creates a trusted academy directly, so it is provisioned
          // as operational together with its administrator identity.
          status: "ACTIVE",
        },
      });
      const administrator = existingUser
        ? await tx.user.update({ where: { id: existingUser.id }, data: { roleId: academyAdminRole.id }, select: { id: true, email: true, fullName: true, createdAt: true } })
        : await tx.user.create({
          data: {
            id: randomUUID(), email: adminEmail, fullName: input.adminName.trim(), phone: input.adminPhone?.trim() || null,
            roleId: academyAdminRole.id,
          },
          select: { id: true, email: true, fullName: true, createdAt: true },
        });
      const membership = await tx.academyMembership.create({
        data: { academyId: academy.id, userId: administrator.id, role: "ACADEMY_ADMIN", status: "ACTIVE" },
      });
      await audit(tx, actorId, "ACADEMY_CREATED", "Academy", academy.id, `Created academy ${academy.name}.`, academy.id);
      await audit(tx, actorId, "ACADEMY_ADMIN_ASSIGNED", "AcademyMembership", membership.id, `Provisioned Academy Admin ${adminEmail}.`, academy.id);
      if (!existingUser) {
        await enqueueAccountCreatedEmail(tx, {
          userId: administrator.id,
          recipientEmail: administrator.email,
          userName: administrator.fullName,
          accountCreatedAt: administrator.createdAt.toISOString(),
          academyId: academy.id,
        });
      }
      return { academy, administratorId: administrator.id, membershipId: membership.id, membershipCreated: true, authentication: "EXISTING_CREDENTIALS_OR_GOOGLE" as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw conflict("ACADEMY_IDENTITY_CONFLICT", "The academy slug or email is already in use.");
    throw error;
  }
}

export async function updateAcademy(actorId: string, academyId: string, input: Partial<AcademyInput>) {
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.academy.findFirst({ where: { id: academyId, deletedAt: null } });
      if (!existing) throw notFound("ACADEMY_NOT_FOUND", "The active academy was not found.");
      const data: Prisma.AcademyUpdateInput = {};
      for (const key of ["name", "phone", "address", "city", "state", "country", "postalCode", "website", "description", "adminName", "adminPhone"] as const) if (input[key] !== undefined) data[key] = input[key]!.trim();
      if (input.slug !== undefined) data.slug = normalizeSlug(input.slug);
      if (input.email !== undefined) data.email = input.email.toLowerCase();

      const requestedAdminEmail = input.adminEmail?.trim().toLowerCase() ?? existing.adminEmail.trim().toLowerCase();
      data.adminEmail = requestedAdminEmail;

      const academyAdminRole = await tx.role.findFirst({ where: { key: "ACADEMY_ADMIN", isActive: true }, select: { id: true } });
      if (!academyAdminRole) throw serviceUnavailable("IDENTITY_CONFIGURATION_ERROR", "The Academy Admin role is not available.");

      const currentMemberships = await tx.academyMembership.findMany({
        where: { academyId, role: "ACADEMY_ADMIN", status: { in: ["ACTIVE", "INVITED"] } },
        select: { id: true, userId: true, user: { select: { email: true } } },
        orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
      });
      const currentPrimary = currentMemberships.find((membership) => membership.user.email.toLowerCase() === existing.adminEmail.toLowerCase()) ?? currentMemberships[0];
      let administrator = await tx.user.findUnique({
        where: { email: requestedAdminEmail },
        select: { id: true, email: true, fullName: true, createdAt: true, deletedAt: true, role: { select: { key: true } } },
      });
      const createsAdministratorAccount = !administrator;
      if (administrator?.deletedAt) throw conflict("ADMIN_IDENTITY_CONFLICT", "The administrator email belongs to a deleted account.");
      if (administrator && !["ACADEMY_ADMIN", "admin", "ACADEMY_STUDENT", "student"].includes(administrator.role.key)) {
        throw conflict("ADMIN_IDENTITY_CONFLICT", "The administrator email already belongs to an incompatible platform identity.");
      }
      if (administrator) {
        const foreignMembership = await tx.academyMembership.findFirst({
          where: { userId: administrator.id, academyId: { not: academyId }, status: "ACTIVE" },
          select: { id: true },
        });
        if (foreignMembership) throw conflict("ADMIN_IDENTITY_CONFLICT", "The administrator identity already has an active academy membership.");
        administrator = await tx.user.update({
          where: { id: administrator.id },
          data: {
            roleId: academyAdminRole.id,
            ...(input.adminName !== undefined ? { fullName: input.adminName.trim() } : {}),
            ...(input.adminPhone !== undefined ? { phone: input.adminPhone.trim() || null } : {}),
          },
          select: { id: true, email: true, fullName: true, createdAt: true, deletedAt: true, role: { select: { key: true } } },
        });
      } else {
        administrator = await tx.user.create({
          data: {
            id: randomUUID(),
            email: requestedAdminEmail,
            fullName: input.adminName?.trim() || existing.adminName,
            phone: input.adminPhone?.trim() || existing.adminPhone || null,
            roleId: academyAdminRole.id,
          },
          select: { id: true, email: true, fullName: true, createdAt: true, deletedAt: true, role: { select: { key: true } } },
        });
      }

      await tx.academyMembership.updateMany({
        where: { academyId, role: "ACADEMY_ADMIN", userId: { not: administrator.id }, status: { in: ["ACTIVE", "INVITED"] } },
        data: { status: "REVOKED" },
      });
      const administratorMembership = await tx.academyMembership.upsert({
        where: { userId_academyId: { userId: administrator.id, academyId } },
        create: { academyId, userId: administrator.id, role: "ACADEMY_ADMIN", status: "ACTIVE" },
        update: { role: "ACADEMY_ADMIN", status: "ACTIVE" },
        select: { id: true },
      });

      const updated = await tx.academy.update({ where: { id: academyId }, data });
      if (createsAdministratorAccount) {
        await enqueueAccountCreatedEmail(tx, {
          userId: administrator.id,
          recipientEmail: administrator.email,
          userName: administrator.fullName,
          accountCreatedAt: administrator.createdAt.toISOString(),
          academyId,
        });
      }
      if (!currentPrimary || currentPrimary.userId !== administrator.id) {
        await audit(tx, actorId, "ACADEMY_ADMIN_ASSIGNED", "AcademyMembership", administratorMembership.id, `Assigned Academy Admin ${requestedAdminEmail}.`, academyId, currentPrimary ? { userId: currentPrimary.userId, email: currentPrimary.user.email } : undefined, { userId: administrator.id, email: requestedAdminEmail });
      }
      await audit(tx, actorId, "ACADEMY_UPDATED", "Academy", academyId, `Updated academy ${updated.name}.`, academyId, { name: existing.name, email: existing.email, status: existing.status, adminEmail: existing.adminEmail }, { name: updated.name, email: updated.email, status: updated.status, adminEmail: updated.adminEmail });
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw conflict("ACADEMY_IDENTITY_CONFLICT", "The academy slug, academy email, or administrator email is already in use.");
    throw error;
  }
}

async function nextAcademyCode(tx: Prisma.TransactionClient, name: string) {
  const letters = name.toUpperCase().replace(/[^A-Z0-9 ]/g, "").split(/\s+/).filter(Boolean).map((word) => word[0]).join("").slice(0, 3).padEnd(3, "X");
  for (let sequence = 1; sequence <= 9_999; sequence += 1) {
    const code = `${letters}${String(sequence).padStart(3, "0")}`;
    if (!await tx.academy.findFirst({ where: { academyCode: code }, select: { id: true } })) return code;
  }
  throw serviceUnavailable("ACADEMY_CODE_EXHAUSTED", "An academy code could not be allocated. Please try again.");
}

type ProvisionedAcademyResult = {
  academy: Prisma.AcademyGetPayload<Record<string, never>> & {
    code: string;
    onboardingStatus: "SETUP_PENDING";
  };
  administratorId: string;
  membershipId: string;
  membershipCreated: true;
  invitationQueued: boolean;
  authentication: "EXISTING_CREDENTIALS_OR_GOOGLE";
};

async function createProvisionedAcademy(actorId: string, input: AcademyProvisioningInput): Promise<ProvisionedAcademyResult> {
  const scope = `academy:create:${actorId}`;
  const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const previous = await prisma.idempotencyRecord.findUnique({ where: { scope_key: { scope, key: input.requestKey } } });
  if (previous) {
    if (previous.requestHash !== requestHash) throw conflict("IDEMPOTENCY_KEY_REUSED", "This create request key was already used with different academy details.");
    return previous.responseBody as unknown as ProvisionedAcademyResult;
  }

  const adminEmail = input.primaryAdmin.email.trim().toLowerCase();
  try {
    return await prisma.$transaction(async (tx) => {
      const academyAdminRole = await tx.role.findFirst({ where: { key: "ACADEMY_ADMIN", isActive: true }, select: { id: true } });
      if (!academyAdminRole) throw serviceUnavailable("IDENTITY_CONFIGURATION_ERROR", "The Academy Admin role is not available.");
      const existingUser = await tx.user.findUnique({ where: { email: adminEmail }, select: { id: true, deletedAt: true, role: { select: { key: true } } } });
      if (existingUser?.deletedAt) throw conflict("ADMIN_IDENTITY_CONFLICT", "The administrator email belongs to a deleted account.");
      if (existingUser && !["ACADEMY_ADMIN", "admin", "ACADEMY_STUDENT", "student"].includes(existingUser.role.key)) throw conflict("ADMIN_IDENTITY_CONFLICT", "The administrator email belongs to an incompatible platform identity.");
      if (existingUser && await tx.academyMembership.count({ where: { userId: existingUser.id, status: "ACTIVE" } })) throw conflict("ADMIN_IDENTITY_CONFLICT", "This administrator already manages another academy.");

      const uploadIds = [input.academy.logoUploadId, input.legal.gstCertificateUploadId].filter((id): id is string => Boolean(id));
      const uploads = uploadIds.length ? await tx.storageUpload.findMany({ where: { id: { in: uploadIds }, createdById: actorId, status: "AVAILABLE", expiresAt: { gt: new Date() } } }) : [];
      if (uploads.length !== uploadIds.length) throw badRequest("INVALID_ACADEMY_ASSET", "One or more academy uploads are unavailable or incomplete.");
      const logo = uploads.find((upload) => upload.id === input.academy.logoUploadId);
      const gstCertificate = uploads.find((upload) => upload.id === input.legal.gstCertificateUploadId);
      if (logo && !logo.mimeType.startsWith("image/")) throw badRequest("INVALID_LOGO_TYPE", "Academy logo must be an image.");
      if (gstCertificate && !["application/pdf", "image/jpeg", "image/png"].includes(gstCertificate.mimeType)) throw badRequest("INVALID_GST_CERTIFICATE_TYPE", "GST certificate must be a PDF, JPEG, or PNG file.");

      const code = await nextAcademyCode(tx, input.academy.name);
      const slug = normalizeSlug(`${input.academy.displayName}-${code}`);
      const academyAddress = input.addresses.academy;
      const academy = await tx.academy.create({ data: {
        slug, academyCode: code, name: input.academy.name.trim(), displayName: input.academy.displayName.trim(), academyType: input.academy.type,
        email: input.academy.email.trim().toLowerCase(), phone: input.academy.phone.trim(), address: [academyAddress.addressLine1, academyAddress.addressLine2].filter(Boolean).join(", "),
        city: academyAddress.city, state: academyAddress.state, country: academyAddress.country, postalCode: academyAddress.postalCode,
        website: input.academy.website?.trim() ?? "", description: input.academy.description?.trim() ?? "", logoUrl: logo?.objectKey ?? "",
        establishedYear: input.academy.establishedYear, socialLinks: input.academy.socialLinks,
        adminName: input.primaryAdmin.fullName.trim(), adminEmail, adminPhone: input.primaryAdmin.mobile.trim(),
        status: input.commercial.subscriptionStatus === "SUSPENDED" ? "SUSPENDED" : "ACTIVE",
      } });

      const administrator = existingUser
        ? await tx.user.update({ where: { id: existingUser.id }, data: { roleId: academyAdminRole.id, fullName: input.primaryAdmin.fullName.trim(), phone: input.primaryAdmin.mobile.trim() }, select: { id: true, email: true, fullName: true, createdAt: true } })
        : await tx.user.create({ data: { id: randomUUID(), email: adminEmail, fullName: input.primaryAdmin.fullName.trim(), phone: input.primaryAdmin.mobile.trim(), roleId: academyAdminRole.id }, select: { id: true, email: true, fullName: true, createdAt: true } });
      const membership = await tx.academyMembership.create({ data: { academyId: academy.id, userId: administrator.id, role: "ACADEMY_ADMIN", status: "ACTIVE" } });

      await tx.academyProfile.create({ data: { academyId: academy.id, createdById: actorId, onboardingStatus: "SETUP_PENDING", logoStoragePath: logo?.objectKey } });
      await tx.academyContact.createMany({ data: [
        { academyId: academy.id, role: "PRIMARY_ADMIN", fullName: input.primaryAdmin.fullName.trim(), email: adminEmail, phone: input.primaryAdmin.mobile.trim(), isPrimary: true },
        ...input.contacts.map((contact) => ({ academyId: academy.id, role: contact.role, fullName: contact.fullName.trim(), email: contact.email?.trim().toLowerCase(), phone: contact.phone?.trim(), isPrimary: false })),
      ] });
      await tx.academyLegalProfile.create({ data: { academyId: academy.id, legalName: input.legal.legalName, entityType: input.legal.entityType, panStatus: input.legal.panStatus, pan: input.legal.pan, tan: input.legal.tan, gstStatus: input.legal.gstStatus, gstin: input.legal.gstin, gstState: input.legal.gstState, gstRegistrationType: input.legal.gstRegistrationType, gstRegistrationDate: input.legal.gstRegistrationDate ? new Date(`${input.legal.gstRegistrationDate}T00:00:00.000Z`) : undefined, gstCertificateStoragePath: gstCertificate?.objectKey, placeOfSupply: input.legal.placeOfSupply } });
      const billingAddress = input.addresses.billingSameAsAcademy ? academyAddress : input.addresses.billing!;
      await tx.academyAddress.createMany({ data: [
        { academyId: academy.id, kind: "ACADEMY", ...academyAddress },
        { academyId: academy.id, kind: "BILLING", ...billingAddress },
      ] });
      await tx.academyBillingProfile.create({ data: { academyId: academy.id, invoiceDisplayName: input.billing.invoiceDisplayName, invoiceEmail: input.billing.invoiceEmail?.toLowerCase(), billingContactName: input.billing.billingContactName, billingContactPhone: input.billing.billingContactPhone, purchaseOrderRequired: input.billing.purchaseOrderRequired, currency: input.billing.currency.toUpperCase() } });
      const offerings = [
        ...input.academic.categories.map((category) => ({ academyId: academy.id, category, program: null as string | null, branch: input.academic.initialBranch ?? null, batch: input.academic.initialBatch ?? null })),
        ...input.academic.programs.map((program) => ({ academyId: academy.id, category: "PROGRAM", program, branch: input.academic.initialBranch ?? null, batch: input.academic.initialBatch ?? null })),
      ];
      if (offerings.length) await tx.academyAcademicOffering.createMany({ data: offerings });
      await tx.academyCommercialProfile.create({ data: { academyId: academy.id, planKey: input.commercial.planKey, subscriptionStatus: input.commercial.subscriptionStatus, startDate: new Date(`${input.commercial.startDate}T00:00:00.000Z`), endDate: input.commercial.endDate ? new Date(`${input.commercial.endDate}T23:59:59.999Z`) : undefined, studentSeatLimit: input.commercial.studentSeatLimit, purchasedSeats: input.commercial.studentSeatLimit, billingCycle: input.commercial.billingCycle } });
      await tx.academyIntegrationProfile.create({ data: { academyId: academy.id, zohoCustomerName: input.legal.legalName ?? input.academy.name, zohoSyncStatus: "NOT_CONFIGURED" } });
      if (uploadIds.length) await tx.storageUpload.updateMany({ where: { id: { in: uploadIds } }, data: { academyId: academy.id } });

      await audit(tx, actorId, "ACADEMY_CREATED", "Academy", academy.id, `Created academy ${academy.name} (${code}).`, academy.id, undefined, { academyCode: code, subscriptionStatus: input.commercial.subscriptionStatus, seatLimit: input.commercial.studentSeatLimit });
      await audit(tx, actorId, "ACADEMY_ADMIN_ASSIGNED", "AcademyMembership", membership.id, `Provisioned Academy Admin ${adminEmail}.`, academy.id);
      if (!existingUser) await enqueueAccountCreatedEmail(tx, { userId: administrator.id, recipientEmail: administrator.email, userName: administrator.fullName, accountCreatedAt: administrator.createdAt.toISOString(), academyId: academy.id });

      const response: ProvisionedAcademyResult = { academy: { ...academy, code, onboardingStatus: "SETUP_PENDING" }, administratorId: administrator.id, membershipId: membership.id, membershipCreated: true, invitationQueued: !existingUser, authentication: "EXISTING_CREDENTIALS_OR_GOOGLE" };
      const responseBody = JSON.parse(JSON.stringify(response)) as Prisma.InputJsonValue;
      await tx.idempotencyRecord.create({ data: { scope, key: input.requestKey, requestHash, responseCode: 201, responseBody, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000) } });
      return response;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw conflict("ACADEMY_IDENTITY_CONFLICT", "An academy with these identifying details already exists.");
    throw error;
  }
}

export async function setAcademyLifecycle(actorId: string, academyId: string, action: "activate" | "suspend" | "archive" | "restore" | "delete") {
  return prisma.$transaction(async (tx) => {
    const academy = await tx.academy.findUnique({ where: { id: academyId } });
    if (!academy || (action !== "restore" && academy.deletedAt && action !== "archive")) throw notFound("ACADEMY_NOT_FOUND", "The academy was not found in the requested lifecycle state.");
    if ((action === "delete" || action === "archive") && await tx.order.count({ where: { course: { academyId }, status: { in: ["CREATED", "PAID"] } } }) > 0) {
      if (action === "delete") {
        throw conflict("ACADEMY_HAS_FINANCIAL_RECORDS", "Academies with financial records cannot be physically deleted; archive or suspend them instead.");
      }
    }

    let status: "ACTIVE" | "PENDING" | "SUSPENDED" | "ARCHIVED" = academy.status;
    let deletedAt: Date | null = academy.deletedAt;

    if (action === "activate") {
      status = "ACTIVE";
      deletedAt = null;
    } else if (action === "suspend") {
      status = "SUSPENDED";
    } else if (action === "archive" || action === "delete") {
      status = "ARCHIVED";
      deletedAt = new Date();
    } else if (action === "restore") {
      status = "ACTIVE";
      deletedAt = null;
    }

    const updated = await tx.academy.update({ where: { id: academyId }, data: { status, deletedAt } });
    if (action === "suspend" || action === "archive") {
      await tx.academyMembership.updateMany({ where: { academyId, status: "ACTIVE" }, data: { status: "SUSPENDED" } });
    } else if (action === "activate" || action === "restore") {
      await tx.academyMembership.updateMany({ where: { academyId, status: "SUSPENDED" }, data: { status: "ACTIVE" } });
    }
    await audit(tx, actorId, `ACADEMY_${action.toUpperCase()}D`, "Academy", academyId, `${action.toUpperCase()} academy ${academy.name}.`, academyId);
    return updated;
  });
}

export async function inviteAcademyAdmin(actorId: string, academyId: string, input: { email: string; name: string }) {
  const email = input.email.toLowerCase();
  return prisma.$transaction(async (tx) => {
    const academy = await tx.academy.findFirst({ where: { id: academyId, deletedAt: null } });
    if (!academy) throw notFound("ACADEMY_NOT_FOUND", "The academy was not found.");
    if (await tx.academyInvitation.findFirst({ where: { academyId, email, status: "PENDING" } })) throw conflict("INVITATION_ALREADY_PENDING", "A pending administrator invitation already exists for this email.");
    const user = await tx.user.findFirst({ where: { email, deletedAt: null } });
    if (user) await tx.academyMembership.upsert({ where: { userId_academyId: { userId: user.id, academyId } }, create: { userId: user.id, academyId, role: "ACADEMY_ADMIN", status: "INVITED" }, update: { role: "ACADEMY_ADMIN", status: "INVITED" } });
    const invitation = await tx.academyInvitation.create({ data: { academyId, email, studentName: input.name.trim(), role: "ACADEMY_ADMIN", status: "PENDING", invitedBy: actorId, expiresAt: new Date(Date.now() + 7 * 86_400_000) } });
    await audit(tx, actorId, "ACADEMY_ADMIN_INVITED", "AcademyInvitation", invitation.id, `Invited administrator ${email}.`, academyId);
    return { invitation, membershipCreated: Boolean(user), deliveryStatus: "EMAIL_PROVIDER_NOT_CONFIGURED" as const };
  });
}

export async function revokeAcademyAdmin(actorId: string, academyId: string, userId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const membership = await tx.academyMembership.findFirst({ where: { academyId, userId, role: "ACADEMY_ADMIN", status: { in: ["ACTIVE", "INVITED", "SUSPENDED"] } }, include: { user: { select: { email: true } } } });
    if (!membership) throw notFound("ACADEMY_ADMIN_NOT_FOUND", "The academy administrator membership was not found.");
    const activeAdmins = await tx.academyMembership.count({ where: { academyId, role: "ACADEMY_ADMIN", status: "ACTIVE" } });
    if (membership.status === "ACTIVE" && activeAdmins <= 1) throw conflict("LAST_ACADEMY_ADMIN", "The last active academy administrator cannot be revoked.");
    const updated = await tx.academyMembership.update({ where: { id: membership.id }, data: { status: "REVOKED" } });
    await tx.academyInvitation.updateMany({ where: { academyId, email: membership.user.email, status: "PENDING" }, data: { status: "REVOKED" } });
    await audit(tx, actorId, "ACADEMY_ADMIN_REVOKED", "AcademyMembership", membership.id, `Revoked academy administrator: ${reason}.`, academyId);
    return updated;
  });
}

export async function listPackages(input: { page: number; limit: number; courseId?: string; status?: "DRAFT" | "PUBLISHED" | "ARCHIVED"; includeDeleted?: boolean; search?: string }) {
  const searchFilter = input.search ? { OR: [{ title: { contains: input.search, mode: "insensitive" as const } }, { description: { contains: input.search, mode: "insensitive" as const } }] } : {};
  const where: Prisma.PackageWhereInput = { ...(input.courseId ? { courseId: input.courseId } : {}), ...(input.status ? { status: input.status } : {}), ...(input.includeDeleted ? {} : { deletedAt: null }), ...searchFilter };
  const [data, total] = await Promise.all([prisma.package.findMany({ where, skip: (input.page - 1) * input.limit, take: input.limit, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: { course: { select: { id: true, name: true, code: true, academyId: true } }, items: { orderBy: { displayOrder: "asc" }, include: { contentItem: { select: { id: true, name: true, accessType: true, accessDurationValue: true, accessDurationUnit: true, status: true, kind: true, size: true } } } }, questionBanks: { orderBy: { displayOrder: "asc" }, include: { questionBank: { select: { id: true, name: true, slug: true, accessType: true, price: true, status: true, _count: { select: { questions: true } } } } } } } }), prisma.package.count({ where })]);
  return { data, pagination: pagination(input.page, input.limit, total) };
}

export async function getPackage(packageId: string) {
  const item = await prisma.package.findUnique({ where: { id: packageId }, include: { course: true, items: { orderBy: { displayOrder: "asc" }, include: { contentItem: true } }, questionBanks: { orderBy: { displayOrder: "asc" }, include: { questionBank: { include: { _count: { select: { questions: true } } } } } }, couponTargets: true, entitlements: { take: 50, orderBy: { grantedAt: "desc" } } } });
  if (!item) throw notFound("PACKAGE_NOT_FOUND", "The package was not found.");
  return item;
}

export async function createPackage(actorId: string, input: { courseId: string; title: string; slug?: string; description?: string; price: number; accessDurationValue?: number | null; accessDurationUnit?: "DAYS" | "WEEKS" | "MONTHS" | null; status?: "DRAFT" | "PUBLISHED"; contentItemIds?: string[]; questionBankIds?: string[] }) {
  return prisma.$transaction(async (tx) => {
    const course = await tx.course.findFirst({ where: { id: input.courseId, deletedAt: null } });
    if (!course) throw notFound("COURSE_NOT_FOUND", "The package course was not found.");
    const ids = [...new Set(input.contentItemIds ?? [])];
    const questionBankIds = [...new Set(input.questionBankIds ?? [])];
    if (ids.length && await tx.contentItem.count({ where: { id: { in: ids }, courseId: input.courseId, deletedAt: null } }) !== ids.length) throw badRequest("INVALID_PACKAGE_ITEMS", "Every package item must be active content in the package course.");
    if (questionBankIds.length && await tx.questionBank.count({ where: { id: { in: questionBankIds }, courseId: input.courseId, deletedAt: null } }) !== questionBankIds.length) throw badRequest("INVALID_PACKAGE_QUESTION_BANKS", "Every Question Bank must be active and belong to the package course.");
    const duration = normalizeAccessDurationPolicy({ accessType: "PAID", accessDurationValue: input.accessDurationValue, accessDurationUnit: input.accessDurationUnit });
    const item = await tx.package.create({ data: { courseId: input.courseId, title: input.title.trim(), slug: normalizeSlug(input.slug ?? input.title), description: input.description?.trim() ?? "", price: input.price, accessDurationValue: duration.accessDurationValue, accessDurationUnit: duration.accessDurationUnit, status: input.status ?? "DRAFT", items: ids.length ? { create: ids.map((contentItemId, displayOrder) => ({ contentItemId, displayOrder })) } : undefined, questionBanks: questionBankIds.length ? { create: questionBankIds.map((questionBankId, displayOrder) => ({ questionBankId, displayOrder })) } : undefined }, include: { items: true, questionBanks: true } });
    await audit(tx, actorId, "PACKAGE_CREATED", "Package", item.id, `Created package ${item.title}.`, course.academyId ?? undefined);
    return item;
  });
}

export async function updatePackage(actorId: string, packageId: string, input: { title?: string; slug?: string; description?: string; price?: number; accessDurationValue?: number | null; accessDurationUnit?: "DAYS" | "WEEKS" | "MONTHS" | null; status?: "DRAFT" | "PUBLISHED" | "ARCHIVED"; contentItemIds?: string[]; questionBankIds?: string[] }) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.package.findFirst({ where: { id: packageId, deletedAt: null }, include: { course: true } });
    if (!existing) throw notFound("PACKAGE_NOT_FOUND", "The package was not found.");
    if (input.contentItemIds) {
      const ids = [...new Set(input.contentItemIds)];
      if (await tx.contentItem.count({ where: { id: { in: ids }, courseId: existing.courseId, deletedAt: null } }) !== ids.length) throw badRequest("INVALID_PACKAGE_ITEMS", "Every package item must be active content in the package course.");
      await tx.packageItem.deleteMany({ where: { packageId } });
      if (ids.length) await tx.packageItem.createMany({ data: ids.map((contentItemId, displayOrder) => ({ packageId, contentItemId, displayOrder })) });
    }
    if (input.questionBankIds) {
      const questionBankIds = [...new Set(input.questionBankIds)];
      if (await tx.questionBank.count({ where: { id: { in: questionBankIds }, courseId: existing.courseId, deletedAt: null } }) !== questionBankIds.length) throw badRequest("INVALID_PACKAGE_QUESTION_BANKS", "Every Question Bank must be active and belong to the package course.");
      await tx.packageQuestionBank.deleteMany({ where: { packageId } });
      if (questionBankIds.length) await tx.packageQuestionBank.createMany({ data: questionBankIds.map((questionBankId, displayOrder) => ({ packageId, questionBankId, displayOrder })) });
    }
    const duration = normalizeAccessDurationPolicy({ accessType: "PAID", accessDurationValue: input.accessDurationValue === undefined ? existing.accessDurationValue : input.accessDurationValue, accessDurationUnit: input.accessDurationUnit === undefined ? existing.accessDurationUnit : input.accessDurationUnit });
    const updated = await tx.package.update({ where: { id: packageId }, data: { ...(input.title !== undefined ? { title: input.title.trim() } : {}), ...(input.slug !== undefined ? { slug: normalizeSlug(input.slug) } : {}), ...(input.description !== undefined ? { description: input.description.trim() } : {}), ...(input.price !== undefined ? { price: input.price } : {}), accessDurationValue: duration.accessDurationValue, accessDurationUnit: duration.accessDurationUnit, ...(input.status !== undefined ? { status: input.status } : {}) }, include: { items: true, questionBanks: true } });
    await audit(tx, actorId, "PACKAGE_UPDATED", "Package", packageId, `Updated package ${updated.title}.`, existing.course.academyId ?? undefined);
    return updated;
  });
}

export async function archivePackage(actorId: string, packageId: string, restore = false) {
  return prisma.$transaction(async (tx) => {
    const item = await tx.package.findFirst({ where: { id: packageId, ...(restore ? { deletedAt: { not: null } } : { deletedAt: null }) }, include: { course: true } });
    if (!item) throw notFound("PACKAGE_NOT_FOUND", "The package was not found in the requested lifecycle state.");
    const updated = await tx.package.update({ where: { id: packageId }, data: restore ? { deletedAt: null, status: "DRAFT" } : { deletedAt: new Date(), status: "ARCHIVED" } });
    await audit(tx, actorId, restore ? "PACKAGE_RESTORED" : "PACKAGE_ARCHIVED", "Package", item.id, `${restore ? "Restored" : "Archived"} package ${item.title}.`, item.course.academyId ?? undefined);
    return updated;
  });
}

export async function listCoupons(input: { page: number; limit: number; enabled?: boolean }) {
  const where = input.enabled === undefined ? {} : { enabled: input.enabled };
  const [data, total] = await Promise.all([prisma.coupon.findMany({ where, skip: (input.page - 1) * input.limit, take: input.limit, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: { targets: true, _count: { select: { redemptions: true } } } }), prisma.coupon.count({ where })]);
  return { data, pagination: pagination(input.page, input.limit, total) };
}

export async function createCoupon(actorId: string, input: { code: string; discountType: "PERCENT" | "FLAT"; discountValue: number; scope?: "ALL" | "PACKAGES" | "SUBJECTS"; maxUses?: number; expiresAt?: string; packageIds?: string[]; subjectIds?: string[] }) {
  if (input.discountType === "PERCENT" && input.discountValue > 100) throw badRequest("INVALID_DISCOUNT", "Percentage discounts cannot exceed 100.");
  return prisma.$transaction(async (tx) => {
    const packageIds = [...new Set(input.packageIds ?? [])]; const subjectIds = [...new Set(input.subjectIds ?? [])];
    if (packageIds.length && await tx.package.count({ where: { id: { in: packageIds }, deletedAt: null } }) !== packageIds.length) throw badRequest("INVALID_COUPON_TARGETS", "One or more package targets are invalid.");
    if (subjectIds.length && await tx.subject.count({ where: { id: { in: subjectIds }, deletedAt: null } }) !== subjectIds.length) throw badRequest("INVALID_COUPON_TARGETS", "One or more subject targets are invalid.");
    const coupon = await tx.coupon.create({ data: { code: input.code.trim().toUpperCase(), discountType: input.discountType, discountValue: input.discountValue, scope: input.scope ?? "ALL", maxUses: input.maxUses, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, targets: (packageIds.length || subjectIds.length) ? { create: [...packageIds.map((packageId) => ({ packageId })), ...subjectIds.map((subjectId) => ({ subjectId }))] } : undefined }, include: { targets: true } });
    await audit(tx, actorId, "COUPON_CREATED", "Coupon", coupon.id, `Created coupon ${coupon.code}.`);
    return coupon;
  });
}

export async function updateCoupon(actorId: string, couponId: string, input: { enabled?: boolean; maxUses?: number | null; expiresAt?: string | null }) {
  const existing = await prisma.coupon.findUnique({ where: { id: couponId } });
  if (!existing) throw notFound("COUPON_NOT_FOUND", "The coupon was not found.");
  return prisma.$transaction(async (tx) => {
    const updated = await tx.coupon.update({ where: { id: couponId }, data: { ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}), ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null } : {}) } });
    await audit(tx, actorId, "COUPON_UPDATED", "Coupon", couponId, `Updated coupon ${updated.code}.`);
    return updated;
  });
}

type ResourceType = "COURSE" | "PACKAGE" | "QUESTION_BANK" | "LESSON" | "PREMIUM_NOTES" | "SUBJECT" | "OTHER";

export interface EntitlementResourceOption {
  id: string;
  resourceType: ResourceType;
  title: string;
  subtitle: string;
}

export async function listEntitlementResources(input: { resourceType: ResourceType; search?: string; limit: number }): Promise<{ data: EntitlementResourceOption[] }> {
  const nameFilter = input.search ? { contains: input.search, mode: "insensitive" as const } : undefined;

  if (input.resourceType === "COURSE") {
    const records = await prisma.course.findMany({
      where: { deletedAt: null, ...(nameFilter ? { name: nameFilter } : {}) },
      take: input.limit,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, code: true, academy: { select: { name: true } } },
    });
    return { data: records.map((record) => ({ id: record.id, resourceType: input.resourceType, title: record.name, subtitle: `${record.code} · ${record.academy?.name ?? "Platform course"}` })) };
  }

  if (input.resourceType === "PACKAGE") {
    const records = await prisma.package.findMany({
      where: { deletedAt: null, ...(nameFilter ? { title: nameFilter } : {}) },
      take: input.limit,
      orderBy: [{ title: "asc" }, { id: "asc" }],
      select: { id: true, title: true, status: true, course: { select: { name: true } } },
    });
    return { data: records.map((record) => ({ id: record.id, resourceType: input.resourceType, title: record.title, subtitle: `${record.course.name} · ${record.status}` })) };
  }

  if (input.resourceType === "QUESTION_BANK") {
    const records = await prisma.questionBank.findMany({
      where: { deletedAt: null, accessType: "PAID", status: "PUBLISHED", ...(nameFilter ? { name: nameFilter } : {}) },
      take: input.limit,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, course: { select: { name: true } } },
    });
    return { data: records.map((record) => ({ id: record.id, resourceType: input.resourceType, title: record.name, subtitle: record.course.name })) };
  }

  if (input.resourceType === "SUBJECT") {
    const records = await prisma.subject.findMany({
      where: { deletedAt: null, ...(nameFilter ? { name: nameFilter } : {}) },
      take: input.limit,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, course: { select: { name: true } } },
    });
    return { data: records.map((record) => ({ id: record.id, resourceType: input.resourceType, title: record.name, subtitle: record.course.name })) };
  }

  const entityType = input.resourceType === "LESSON"
    ? "LESSON" as const
    : input.resourceType === "PREMIUM_NOTES"
      ? "PREMIUM_NOTE" as const
      : "OTHER" as const;
  const records = await prisma.contentItem.findMany({
    where: { deletedAt: null, status: "PUBLISHED", entityType, ...(nameFilter ? { name: nameFilter } : {}) },
    take: input.limit,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true, kind: true, course: { select: { name: true } } },
  });
  return { data: records.map((record) => ({ id: record.id, resourceType: input.resourceType, title: record.name, subtitle: `${record.course.name} · ${record.kind}` })) };
}

type StudentGrantSelections = { notes: string[]; questionBanks: string[]; bundles: string[]; subscriptions: string[] };
type GrantCatalogResource = { id: string; title: string; subtitle: string };

async function requireActiveStudent(tx: Prisma.TransactionClient, userId: string, academyId?: string) {
  const student = await tx.user.findFirst({ where: { id: userId, deletedAt: null, status: "ACTIVE", ...(academyId ? { academyMemberships: { some: { academyId, role: "ACADEMY_STUDENT", status: "ACTIVE" } } } : {}) }, select: { id: true, fullName: true, email: true, role: { select: { name: true } } } });
  if (!student || student.role.name.toUpperCase() !== "STUDENT") throw notFound("ACTIVE_STUDENT_NOT_FOUND", "The active student was not found.");
  return student;
}

async function getStudentCourseIds(tx: Prisma.TransactionClient, userId: string, now = new Date(), academyId?: string) {
  if (academyId) {
    const [enrollments, preference] = await Promise.all([
      tx.academyCourseEnrollment.findMany({
        where: { studentId: userId, academyId, status: { in: ["ACTIVE", "COMPLETED"] }, course: { academyId, status: "ACTIVE", deletedAt: null } },
        select: { courseId: true },
      }),
      tx.learnerPreference.findUnique({
        where: { userId },
        select: { selectedCourse: { select: { id: true, academyId: true, status: true, deletedAt: true } } },
      }),
    ]);
    const ids = new Set(enrollments.map((item) => item.courseId));
    const selectedCourse = preference?.selectedCourse;
    if (selectedCourse?.academyId === academyId && selectedCourse.status === "ACTIVE" && !selectedCourse.deletedAt) {
      ids.add(selectedCourse.id);
    }
    return [...ids];
  }
  const [enrollments, preference, orders, entitlements] = await Promise.all([
    tx.academyCourseEnrollment.findMany({ where: { studentId: userId, status: { in: ["ACTIVE", "COMPLETED"] }, course: { status: "ACTIVE", deletedAt: null } }, select: { courseId: true } }),
    tx.learnerPreference.findUnique({ where: { userId }, select: { selectedCourse: { select: { id: true, status: true, deletedAt: true } } } }),
    tx.order.findMany({ where: { userId, status: "PAID", course: { status: "ACTIVE", deletedAt: null } }, select: { courseId: true } }),
    tx.entitlement.findMany({
      where: { userId, status: "ACTIVE", startsAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { courseId: true, contentItem: { select: { courseId: true } }, package: { select: { courseId: true } }, questionBank: { select: { courseId: true } }, subject: { select: { courseId: true } } },
    }),
  ]);
  const ids = new Set<string>(enrollments.map((item) => item.courseId));
  if (preference?.selectedCourse?.status === "ACTIVE" && !preference.selectedCourse.deletedAt) ids.add(preference.selectedCourse.id);
  for (const order of orders) if (order.courseId) ids.add(order.courseId);
  for (const entitlement of entitlements) {
    const courseId = entitlement.courseId ?? entitlement.contentItem?.courseId ?? entitlement.package?.courseId ?? entitlement.questionBank?.courseId ?? entitlement.subject?.courseId;
    if (courseId) ids.add(courseId);
  }
  return [...ids];
}

export async function getStudentGrantAccessCatalog(userId: string, courseId?: string, academyId?: string) {
  return prisma.$transaction(async (tx) => {
    await requireActiveStudent(tx, userId, academyId);
    const allowedCourseIds = await getStudentCourseIds(tx, userId, new Date(), academyId);
    const courses = allowedCourseIds.length ? await tx.course.findMany({ where: { id: { in: allowedCourseIds }, ...(academyId ? { academyId } : {}), status: "ACTIVE", deletedAt: null }, orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, name: true, code: true } }) : [];
    if (!courseId) return { studentId: userId, courses, selectedCourseId: null, resources: null, activeManualGrantIds: null };
    if (!courses.some((course) => course.id === courseId)) throw badRequest("STUDENT_COURSE_REQUIRED", "Select a course that this student is enrolled in or already has access to.");

    const [notes, questionBanks, bundles, activeManualGrants] = await Promise.all([
      tx.contentItem.findMany({ where: { courseId, kind: "FILE", accessType: "PAID", price: { not: null }, status: "PUBLISHED", deletedAt: null, AND: [{ OR: [{ entityType: null }, { entityType: { not: "MONTHLY_REPORT" } }] }] }, orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, name: true } }),
      tx.questionBank.findMany({ where: { courseId, accessType: "PAID", price: { gt: 0 }, status: "PUBLISHED", deletedAt: null }, orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, name: true } }),
      tx.package.findMany({ where: { courseId, price: { gt: 0 }, status: "PUBLISHED", deletedAt: null, questionBank: { is: null } }, orderBy: [{ title: "asc" }, { id: "asc" }], select: { id: true, title: true, _count: { select: { items: true, questionBanks: true } } } }),
      tx.entitlement.findMany({
        where: {
          userId,
          source: "ADMIN_GRANT",
          status: "ACTIVE",
          startsAt: { lte: new Date() },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { contentItemId: true, questionBankId: true, packageId: true },
      }),
    ]);
    return {
      studentId: userId,
      courses,
      selectedCourseId: courseId,
      resources: {
        notes: notes.map<GrantCatalogResource>((item) => ({ id: item.id, title: item.name, subtitle: "Paid note" })),
        questionBanks: questionBanks.map<GrantCatalogResource>((item) => ({ id: item.id, title: item.name, subtitle: "Paid Question Bank" })),
        bundles: bundles.map<GrantCatalogResource>((item) => ({ id: item.id, title: item.title, subtitle: `${item._count.items + item._count.questionBanks} included resources` })),
        // No durable Subscription product exists yet. Keep this requested
        // category visible without manufacturing data or relabelling packages.
        subscriptions: [] as GrantCatalogResource[],
      },
      activeManualGrantIds: {
        notes: activeManualGrants.flatMap((item) => item.contentItemId ? [item.contentItemId] : []),
        questionBanks: activeManualGrants.flatMap((item) => item.questionBankId ? [item.questionBankId] : []),
        bundles: activeManualGrants.flatMap((item) => item.packageId ? [item.packageId] : []),
        subscriptions: [] as string[],
      },
    };
  });
}

export async function grantStudentAccess(actorId: string, userId: string, input: { courseId: string; selections: StudentGrantSelections; expiresAt?: string | null }, academyId?: string) {
  const selections: StudentGrantSelections = { notes: [...new Set(input.selections.notes)], questionBanks: [...new Set(input.selections.questionBanks)], bundles: [...new Set(input.selections.bundles)], subscriptions: [...new Set(input.selections.subscriptions)] };
  if (!Object.values(selections).some((ids) => ids.length)) throw badRequest("GRANT_SELECTION_REQUIRED", "Select at least one resource to grant.");
  if (selections.subscriptions.length) throw badRequest("SUBSCRIPTIONS_UNAVAILABLE", "No grantable subscription products are currently available.");
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) throw badRequest("INVALID_GRANT_EXPIRY", "The access expiry must be a future date.");

  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const student = await requireActiveStudent(tx, userId, academyId);
    await tx.entitlement.updateMany({ where: { userId, status: "ACTIVE", expiresAt: { lte: now } }, data: { status: "EXPIRED" } });
    if (!(await getStudentCourseIds(tx, userId, now, academyId)).includes(input.courseId)) throw badRequest("STUDENT_COURSE_REQUIRED", "The selected course is no longer available to this student.");
    const [notes, questionBanks, bundles] = await Promise.all([
      selections.notes.length ? tx.contentItem.findMany({ where: { id: { in: selections.notes }, courseId: input.courseId, kind: "FILE", accessType: "PAID", price: { not: null }, status: "PUBLISHED", deletedAt: null, AND: [{ OR: [{ entityType: null }, { entityType: { not: "MONTHLY_REPORT" } }] }] }, select: { id: true, name: true } }) : Promise.resolve([]),
      selections.questionBanks.length ? tx.questionBank.findMany({ where: { id: { in: selections.questionBanks }, courseId: input.courseId, accessType: "PAID", price: { gt: 0 }, status: "PUBLISHED", deletedAt: null }, select: { id: true, name: true } }) : Promise.resolve([]),
      selections.bundles.length ? tx.package.findMany({ where: { id: { in: selections.bundles }, courseId: input.courseId, price: { gt: 0 }, status: "PUBLISHED", deletedAt: null, questionBank: { is: null } }, select: { id: true, title: true } }) : Promise.resolve([]),
    ]);
    if (notes.length !== selections.notes.length || questionBanks.length !== selections.questionBanks.length || bundles.length !== selections.bundles.length) throw conflict("GRANT_RESOURCE_CHANGED", "One or more selected resources are no longer paid, published, or available for this course. Refresh and review the selection.");

    const duplicateConditions: Prisma.EntitlementWhereInput[] = [...notes.map((item) => ({ contentItemId: item.id })), ...questionBanks.map((item) => ({ questionBankId: item.id })), ...bundles.map((item) => ({ packageId: item.id }))];
    const duplicates = await tx.entitlement.findMany({ where: { userId, source: "ADMIN_GRANT", status: "ACTIVE", OR: duplicateConditions }, select: { contentItemId: true, questionBankId: true, packageId: true } });
    const duplicateNoteIds = new Set(duplicates.flatMap((item) => item.contentItemId ? [item.contentItemId] : []));
    const duplicateQuestionBankIds = new Set(duplicates.flatMap((item) => item.questionBankId ? [item.questionBankId] : []));
    const duplicateBundleIds = new Set(duplicates.flatMap((item) => item.packageId ? [item.packageId] : []));
    const newNotes = notes.filter((item) => !duplicateNoteIds.has(item.id));
    const newQuestionBanks = questionBanks.filter((item) => !duplicateQuestionBankIds.has(item.id));
    const newBundles = bundles.filter((item) => !duplicateBundleIds.has(item.id));

    const accessType = expiresAt ? "TIME_LIMITED" as const : "PERMANENT" as const;
    const reason = "Granted through Admin Students access workflow.";
    const created = [];
    for (const item of newNotes) created.push(await tx.entitlement.create({ data: { userId, resourceType: "PREMIUM_NOTES", contentItemId: item.id, resourceTitle: item.name, source: "ADMIN_GRANT", accessType, expiresAt, grantedByAdminId: actorId, reason } }));
    for (const item of newQuestionBanks) created.push(await tx.entitlement.create({ data: { userId, resourceType: "QUESTION_BANK", questionBankId: item.id, resourceTitle: item.name, source: "ADMIN_GRANT", accessType, expiresAt, grantedByAdminId: actorId, reason } }));
    for (const item of newBundles) created.push(await tx.entitlement.create({ data: { userId, resourceType: "PACKAGE", packageId: item.id, resourceTitle: item.title, source: "ADMIN_GRANT", accessType, expiresAt, grantedByAdminId: actorId, reason } }));
    for (const entitlement of created) await audit(tx, actorId, "ENTITLEMENT_GRANTED", "Entitlement", entitlement.id, `Granted ${entitlement.resourceTitle} to ${student.email}.`, academyId);
    return { grantedCount: created.length, alreadyActiveCount: duplicates.length, entitlements: created };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function grantEntitlement(actorId: string, input: { userId: string; resourceType: ResourceType; contentItemId?: string; packageId?: string; questionBankId?: string; subjectId?: string; courseId?: string; resourceTitle: string; accessType?: "PERMANENT" | "TIME_LIMITED"; expiresAt?: string; reason: string }) {
  const references = [input.contentItemId, input.packageId, input.questionBankId, input.subjectId, input.courseId].filter(Boolean);
  if (references.length !== 1) throw badRequest("INVALID_ENTITLEMENT_RESOURCE", "Exactly one resource identifier is required.");
  if (input.accessType === "TIME_LIMITED" && !input.expiresAt) throw badRequest("EXPIRY_REQUIRED", "Time-limited access requires expiresAt.");
  return prisma.$transaction(async (tx) => {
    if (!await tx.user.findFirst({ where: { id: input.userId, deletedAt: null, status: "ACTIVE" } })) throw notFound("USER_NOT_FOUND", "The active user was not found.");
    if (input.contentItemId && !await tx.contentItem.findFirst({ where: { id: input.contentItemId, deletedAt: null } })) throw notFound("CONTENT_NOT_FOUND", "The content resource was not found.");
    if (input.packageId && !await tx.package.findFirst({ where: { id: input.packageId, deletedAt: null } })) throw notFound("PACKAGE_NOT_FOUND", "The package resource was not found.");
    if (input.questionBankId && !await tx.questionBank.findFirst({ where: { id: input.questionBankId, deletedAt: null } })) throw notFound("QUESTION_BANK_NOT_FOUND", "The Question Bank resource was not found.");
    if (input.subjectId && !await tx.subject.findFirst({ where: { id: input.subjectId, deletedAt: null } })) throw notFound("SUBJECT_NOT_FOUND", "The subject resource was not found.");
    if (input.courseId && !await tx.course.findFirst({ where: { id: input.courseId, deletedAt: null } })) throw notFound("COURSE_NOT_FOUND", "The course resource was not found.");
    const entitlement = await tx.entitlement.create({ data: { ...input, source: "ADMIN_GRANT", accessType: input.accessType ?? "PERMANENT", expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, grantedByAdminId: actorId } });
    await audit(tx, actorId, "ENTITLEMENT_GRANTED", "Entitlement", entitlement.id, `Granted ${input.resourceTitle} to user ${input.userId}.`);
    return entitlement;
  });
}

const academyEntitlementScope = (academyId: string): Prisma.EntitlementWhereInput => ({
  AND: [
    { user: { academyMemberships: { some: { academyId, role: "ACADEMY_STUDENT" } } } },
    { OR: [
      { course: { academyId } },
      { contentItem: { course: { academyId } } },
      { package: { course: { academyId } } },
      { questionBank: { course: { academyId } } },
      { subject: { course: { academyId } } },
    ] },
  ],
});

export async function revokeEntitlement(actorId: string, entitlementId: string, reason: string, academyId?: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.entitlement.findFirst({ where: { id: entitlementId, source: "ADMIN_GRANT", status: "ACTIVE", ...(academyId ? academyEntitlementScope(academyId) : {}) } });
    if (!existing) throw notFound("ACTIVE_ENTITLEMENT_NOT_FOUND", "The active entitlement was not found.");
    const updated = await tx.entitlement.update({ where: { id: entitlementId }, data: { status: "REVOKED", revokedAt: new Date(), reason } });
    await audit(tx, actorId, "ENTITLEMENT_REVOKED", "Entitlement", entitlementId, `Revoked entitlement: ${reason}.`, academyId);
    return updated;
  });
}

export async function listEntitlements(input: { page: number; limit: number; userId?: string; status?: "ACTIVE" | "EXPIRED" | "REVOKED"; source?: "PURCHASE" | "ADMIN_GRANT" | "SUBSCRIPTION" | "PROMOTION" }) {
  const now = new Date();
  await prisma.entitlement.updateMany({ where: { status: "ACTIVE", expiresAt: { lte: now } }, data: { status: "EXPIRED" } });
  const where: Prisma.EntitlementWhereInput = { ...(input.userId ? { userId: input.userId } : {}), ...(input.status ? { status: input.status } : {}), ...(input.source ? { source: input.source } : {}) };
  const [rows, total] = await Promise.all([prisma.entitlement.findMany({
    where,
    skip: (input.page - 1) * input.limit,
    take: input.limit,
    orderBy: [{ grantedAt: "desc" }, { id: "desc" }],
    include: {
      user: { select: { id: true, email: true, fullName: true } },
      package: { select: { id: true, title: true, course: { select: { id: true, name: true } } } },
      contentItem: { select: { course: { select: { id: true, name: true } } } },
      questionBank: { select: { course: { select: { id: true, name: true } } } },
      subject: { select: { course: { select: { id: true, name: true } } } },
      course: { select: { id: true, name: true } },
    },
  }), prisma.entitlement.count({ where })]);
  const data = rows.map(({ contentItem, questionBank, subject, ...row }) => ({ ...row, course: row.course ?? row.package?.course ?? contentItem?.course ?? questionBank?.course ?? subject?.course ?? null }));
  return { data, pagination: pagination(input.page, input.limit, total) };
}

export async function listAcademyStudentManualEntitlements(userId: string, academyId: string) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const student = await tx.user.findFirst({ where: { id: userId, deletedAt: null, role: { key: { in: ["student", "STUDENT"] } }, academyMemberships: { some: { academyId, role: "ACADEMY_STUDENT" } } }, select: { id: true } });
    if (!student) throw notFound("STUDENT_NOT_FOUND", "The student was not found in this Academy.");
    await tx.entitlement.updateMany({ where: { userId, source: "ADMIN_GRANT", status: "ACTIVE", expiresAt: { lte: now }, ...academyEntitlementScope(academyId) }, data: { status: "EXPIRED" } });
  });
  const rows = await prisma.entitlement.findMany({
    where: { userId, source: "ADMIN_GRANT", ...academyEntitlementScope(academyId) },
    orderBy: [{ grantedAt: "desc" }, { id: "desc" }],
    take: 500,
    include: {
      package: { select: { course: { select: { id: true, name: true } } } },
      contentItem: { select: { course: { select: { id: true, name: true } } } },
      questionBank: { select: { course: { select: { id: true, name: true } } } },
      subject: { select: { course: { select: { id: true, name: true } } } },
      course: { select: { id: true, name: true } },
    },
  });
  return rows.map(({ contentItem, questionBank, subject, ...row }) => ({ ...row, course: row.course ?? row.package?.course ?? contentItem?.course ?? questionBank?.course ?? subject?.course ?? null }));
}

export async function getStoreKpis() {
  const [totalRevenueAgg, totalOrders, activePackages, publishedPaidItems] = await Promise.all([
    prisma.order.aggregate({
      _sum: { totalAmount: true },
      where: { status: { in: ["PAID"] } },
    }),
    prisma.order.count(),
    prisma.package.count({ where: { status: "PUBLISHED", deletedAt: null } }),
    prisma.contentItem.count({ where: { accessType: "PAID", status: "PUBLISHED", deletedAt: null } }),
  ]);

  return {
    totalRevenue: Number(totalRevenueAgg._sum.totalAmount ?? 0),
    totalOrders,
    activePackages,
    publishedPaidItems,
  };
}
