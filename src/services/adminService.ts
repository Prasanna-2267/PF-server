import { randomUUID } from "node:crypto";
import { prisma } from "../db/prisma.js";
import { badRequest, conflict, notFound } from "../errors/api-error.js";
import { changeUserRole, changeUserStatus } from "../auth/user-governance.js";
import { getStudentConceptInsights } from "./studentPerformanceService.js";
import { enqueueUserLifecycleEmail } from "./userLifecycleEmailService.js";
import { createLearnerNotification } from "./learnerNotificationService.js";
import { enqueueJob } from "./backgroundJobService.js";

// A user becomes academy-owned through AcademyMembership.  The global Students
// workspace is deliberately limited to direct Parallax Flow student accounts.
const directPlatformStudentWhere = {
  deletedAt: null,
  role: { key: { in: ["student", "STUDENT"] } },
  academyMemberships: { none: {} },
};

async function requireDirectPlatformStudent(userId: string) {
  const user = await prisma.user.findFirst({ where: { id: userId, ...directPlatformStudentWhere }, select: { id: true } });
  if (!user) throw notFound("PLATFORM_STUDENT_NOT_FOUND", "The platform student was not found.");
  return user;
}

export async function getAdminOverview(courseId?: string) {
  if (courseId) {
    const course = await prisma.course.findFirst({ where: { id: courseId, academyId: null, deletedAt: null } });
    if (!course) {
      throw notFound("COURSE_NOT_FOUND", "Course not found.");
    }
  }

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const orderWhere = courseId ? { courseId } : { course: { academyId: null } };
  const [
    users, activeUsers, academies, courses, orders, paid,
    newStudentsThisWeek,
    contentItems, packages, subjects, questions, coupons,
    recentOrderRows, courseRows,
  ] = await Promise.all([
    prisma.user.count({ where: directPlatformStudentWhere }),
    prisma.user.count({ where: { ...directPlatformStudentWhere, status: "ACTIVE" } }),
    prisma.academy.count({ where: { deletedAt: null } }),
    prisma.course.count({ where: { academyId: null, deletedAt: null } }),
    prisma.order.count({ where: orderWhere }),
    prisma.order.aggregate({ where: { status: "PAID", ...orderWhere }, _sum: { totalAmount: true } }),
    prisma.user.count({ where: { ...directPlatformStudentWhere, createdAt: { gte: oneWeekAgo } } }),
    prisma.contentItem.count({ where: { course: { academyId: null } } }).catch(() => 0),
    prisma.package.count({ where: { course: { academyId: null } } }).catch(() => 0),
    prisma.subject.count({ where: { course: { academyId: null } } }).catch(() => 0),
    prisma.question.count({ where: { academyId: null } }).catch(() => 0),
    prisma.coupon.count().catch(() => 0),
    prisma.order.findMany({
      where: orderWhere,
      take: 5,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        totalAmount: true,
        status: true,
        createdAt: true,
        courseId: true,
        isComplimentary: true,
        currency: true,
        refundStatus: true,
        accessStatus: true,
        paidAt: true,
        refundedAt: true,
        receiptNumber: true,
        paymentMethod: true,
        user: { select: { id: true, fullName: true, email: true } },
        items: { select: { titleSnapshot: true } },
      },
    }).catch(() => []),
    prisma.course.findMany({
      where: courseId ? { id: courseId, academyId: null, deletedAt: null } : { academyId: null, deletedAt: null, status: "ACTIVE" },
      select: {
        id: true,
        name: true,
        packages: {
          select: {
            id: true,
            title: true,
          },
        },
        orders: {
          select: {
            id: true,
            totalAmount: true,
            status: true,
            items: {
              select: {
                titleSnapshot: true,
                totalPrice: true,
                unitPrice: true,
                contentItemId: true,
                packageId: true,
              },
            },
          },
        },
      },
    }).catch(() => []),
  ]);

  const courseMetrics = courseRows.map((course: {
    id: string;
    orders: Array<{
      id: string;
      totalAmount: unknown;
      status: string;
      items?: Array<{ titleSnapshot?: string; totalPrice?: unknown; unitPrice?: unknown; contentItemId?: string | null; packageId?: string | null }>;
    }>;
  }) => {
    const paidOrds = course.orders.filter((o) => o.status === "PAID");
    const failedOrds = course.orders.filter((o) => o.status === "FAILED");
    const refundedOrds = course.orders.filter((o) => o.status === "REFUNDED");
    const revenueMinor = paidOrds.reduce((sum: number, o: { totalAmount: unknown }) => sum + Number(o.totalAmount ?? 0), 0);

    const resourceMap = new Map<string, { productId: string; title: string; revenueMinor: number; purchases: number }>();
    for (const ord of paidOrds) {
      if (ord.items && ord.items.length > 0) {
        for (const item of ord.items) {
          const title = item.titleSnapshot?.trim() || "Learning Resource";
          const key = title;
          const itemRevenue = Number(item.totalPrice ?? item.unitPrice ?? 0);
          const existing = resourceMap.get(key) ?? {
            productId: item.contentItemId ?? item.packageId ?? key,
            title,
            revenueMinor: 0,
            purchases: 0,
          };
          existing.revenueMinor += itemRevenue;
          existing.purchases += 1;
          resourceMap.set(key, existing);
        }
      }
    }
    const resources = Array.from(resourceMap.values()).sort((a, b) => b.revenueMinor - a.revenueMinor || b.purchases - a.purchases);

    return {
      courseId: course.id,
      revenueMinor,
      students: paidOrds.length,
      paidOrders: paidOrds.length,
      failedOrders: failedOrds.length,
      refundedOrders: refundedOrds.length,
      accessGranted: paidOrds.length,
      resources,
    };
  });

  const recentOrders = (recentOrderRows as Array<{
    id: string;
    totalAmount: unknown;
    currency: string;
    status: string;
    refundStatus: string;
    accessStatus: string;
    createdAt: Date;
    courseId: string | null;
    isComplimentary: boolean;
    paidAt: Date | null;
    refundedAt: Date | null;
    receiptNumber: string | null;
    paymentMethod: string | null;
    user: { id: string; fullName: string; email: string };
    items: Array<{ titleSnapshot: string }>;
  }>).map((o) => ({
    id: o.id,
    courseId: o.courseId ?? null,
    amountMinor: Number(o.totalAmount ?? 0),
    currency: 'INR' as const,
    status: o.status as 'CREATED' | 'PAID' | 'FAILED' | 'REFUNDED' | 'CANCELLED',
    refundStatus: o.refundStatus as 'NONE' | 'PARTIAL' | 'FULL',
    accessStatus: o.accessStatus as 'PENDING' | 'GRANTED' | 'REVOKED' | 'NOT_APPLICABLE',
    createdAt: o.createdAt.toISOString(),
    paidAt: o.paidAt ? o.paidAt.toISOString() : null,
    refundedAt: o.refundedAt ? o.refundedAt.toISOString() : null,
    receiptNumber: o.receiptNumber,
    paymentMethod: o.paymentMethod,
    isComplimentary: o.isComplimentary,
    buyer: { studentId: o.user.id, fullName: o.user.fullName, email: o.user.email },
    items: o.items.map((item) => ({ title: item.titleSnapshot })),
  }));

  return {
    users,
    activeUsers,
    academies,
    courses,
    orders,
    paidRevenue: Number(paid._sum.totalAmount ?? 0),
    newStudentsThisWeek,
    metrics: {
      students: users,
      newStudentsThisWeek,
      totalRevenueMinor: Number(paid._sum.totalAmount ?? 0),
    },
    contentCounts: {
      lessons: Number(contentItems),
      packages: Number(packages),
      subjects: Number(subjects),
      questions: Number(questions),
      stages: 0,
      coupons: Number(coupons),
    },
    courseMetrics,
    recentOrders,
  };
}



export async function listAdminUsers(input: { page: number; limit: number; search?: string; status?: "ACTIVE" | "DISABLED"; role?: string; courseId?: string }) {
  const whereConditions: any[] = [directPlatformStudentWhere];

  if (input.status) {
    whereConditions.push({ status: input.status });
  }

  if (input.role) {
    whereConditions.push({
      role: { key: { in: [input.role, input.role.toLowerCase(), input.role.toUpperCase()] } },
    });
  }

  if (input.courseId) {
    whereConditions.push({
      OR: [
        { entitlements: { some: { courseId: input.courseId } } },
        { orders: { some: { courseId: input.courseId, status: "PAID" } } },
      ],
    });
  }

  if (input.search && input.search.trim()) {
    const term = input.search.trim();
    const searchOr: any[] = [
      { fullName: { contains: term, mode: "insensitive" as const } },
      { email: { contains: term, mode: "insensitive" as const } },
      { phone: { contains: term, mode: "insensitive" as const } },
    ];

    // Check if input is a 4-digit year e.g. 2026
    if (/^\d{4}$/.test(term)) {
      const year = parseInt(term, 10);
      searchOr.push({
        createdAt: {
          gte: new Date(Date.UTC(year, 0, 1)),
          lte: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)),
        },
      });
    } else {
      const parsed = Date.parse(term);
      if (!isNaN(parsed)) {
        const dateObj = new Date(parsed);
        const start = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), 0, 0, 0, 0);
        const end = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), 23, 59, 59, 999);
        searchOr.push({
          createdAt: { gte: start, lte: end },
        });
      }
    }

    whereConditions.push({ OR: searchOr });
  }

  const where = { AND: whereConditions };

  const [data, total] = await Promise.all([
    prisma.user.findMany({ where, skip: (input.page - 1) * input.limit, take: input.limit, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, email: true, fullName: true, phone: true, status: true, lastLoginAt: true, createdAt: true, role: { select: { key: true, name: true } } } }),
    prisma.user.count({ where }),
  ]);
  return { data, pagination: { page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit) } };
}

export async function getAdminUser(userId: string) {
  const user = await prisma.user.findFirst({ where: { id: userId, ...directPlatformStudentWhere }, select: {
    id: true, email: true, fullName: true, phone: true, status: true, lastLoginAt: true, createdAt: true, updatedAt: true,
    role: { select: { key: true, name: true, rolePermissions: { select: { permission: { select: { key: true } } } } } },
    sessions: { orderBy: { lastSeenAt: "desc" }, take: 25, select: { id: true, deviceName: true, platform: true, createdAt: true, lastSeenAt: true, expiresAt: true, revokedAt: true } },
    deviceBinding: { select: { deviceName: true, platform: true, boundAt: true, lastVerifiedAt: true, bindingVersion: true, resetApprovedAt: true, resetConsumedAt: true } },
    academyMemberships: { take: 50, select: { id: true, academyId: true, role: true, status: true, academy: { select: { name: true, slug: true } } } },
  } });
  if (!user) throw notFound("USER_NOT_FOUND", "The user was not found.");
  return {
    ...user,
    performanceInsights: await getStudentConceptInsights(userId, { academyId: null }),
  };
}

export async function updateAdminUserRole(actorId: string, userId: string, role: string) {
  await requireDirectPlatformStudent(userId);
  return changeUserRole(actorId, userId, role);
}
export async function updateAdminUserStatus(actorId: string, userId: string, status: "ACTIVE" | "DISABLED") {
  await requireDirectPlatformStudent(userId);
  return changeUserStatus(actorId, userId, status);
}

export async function revokeAdminUserSessions(actorId: string, userId: string) {
  const now = new Date();
  return prisma.$transaction(async (transaction) => {
    const user = await transaction.user.findFirst({ where: { id: userId, ...directPlatformStudentWhere }, select: { id: true } });
    if (!user) throw notFound("USER_NOT_FOUND", "The user was not found.");
    const revoked = await transaction.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, refreshTokenHash: null } });
    await transaction.systemAuditLog.create({ data: { action: "SESSIONS_REVOKED", entityType: "User", entityId: userId, actorId, description: `Revoked ${revoked.count} application sessions.` } });
    await transaction.securityEvent.create({ data: { eventType: "SESSION_REVOKED", riskLevel: "MEDIUM", description: "A Super Admin revoked all application sessions for a user.", userId, actorId } });
    return { revokedSessions: revoked.count };
  });
}

export async function listAdminOrders(input: { page: number; limit: number; search?: string; status?: "CREATED" | "PAID" | "FAILED" | "REFUNDED" | "CANCELLED" }) {
  const whereConditions: any[] = [];
  if (input.status) {
    whereConditions.push({ status: input.status });
  }
  if (input.search && input.search.trim()) {
    const term = input.search.trim();
    whereConditions.push({
      OR: [
        { orderNumber: { contains: term, mode: "insensitive" as const } },
        { id: { contains: term, mode: "insensitive" as const } },
        { user: { fullName: { contains: term, mode: "insensitive" as const } } },
        { user: { email: { contains: term, mode: "insensitive" as const } } },
        { items: { some: { titleSnapshot: { contains: term, mode: "insensitive" as const } } } },
      ],
    });
  }
  const where = whereConditions.length ? { AND: whereConditions } : {};

  const [data, total, totalOrders, paidOrdersCount, refundedOrdersCount, failedOrdersCount, revenueResult] = await Promise.all([
    prisma.order.findMany({
      where,
      skip: (input.page - 1) * input.limit,
      take: input.limit,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        orderNumber: true,
        currency: true,
        subtotal: true,
        discountAmount: true,
        totalAmount: true,
        status: true,
        refundStatus: true,
        accessStatus: true,
        createdAt: true,
        paidAt: true,
        user: { select: { id: true, email: true, fullName: true } },
        items: { select: { id: true, titleSnapshot: true, resourceType: true, totalPrice: true } },
      },
    }),
    prisma.order.count({ where }),
    prisma.order.count(),
    prisma.order.count({ where: { status: "PAID" } }),
    prisma.order.count({ where: { status: "REFUNDED" } }),
    prisma.order.count({ where: { status: "FAILED" } }),
    prisma.order.aggregate({ where: { status: "PAID" }, _sum: { totalAmount: true } }),
  ]);

  const summary = {
    totalOrders,
    paidOrders: paidOrdersCount,
    refundedOrders: refundedOrdersCount,
    failedOrders: failedOrdersCount,
    totalRevenueMinor: Number(revenueResult._sum.totalAmount ?? 0),
  };

  return { data, pagination: { page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit) }, summary };
}

export async function getAdminOrder(orderId: string) {
  const [order, auditLogs] = await Promise.all([
    prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { include: { contentItem: true, package: { select: { id: true, title: true } } } },
        payments: { include: { refunds: true } },
        redemptions: { include: { coupon: true } },
        entitlements: { include: { course: { select: { id: true, name: true } } } },
        user: { select: { id: true, email: true, fullName: true, phone: true } },
      },
    }),
    prisma.systemAuditLog.findMany({
      where: { entityType: "Order", entityId: orderId },
      orderBy: { occurredAt: "asc" },
      select: { id: true, action: true, description: true, occurredAt: true, actorId: true },
    }),
  ]);
  if (!order) throw notFound("ORDER_NOT_FOUND", "The order was not found.");
  return { ...order, auditLogs };
}

export async function refundAdminOrder(actorId: string, orderId: string, input: { amount: number; reason: string; idempotencyKey: string }) {
  return prisma.$transaction(async (tx) => {
    const existingRefund = await tx.paymentRefund.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existingRefund) return existingRefund;
    const payment = await tx.payment.findFirst({ where: { orderId, status: "SUCCESS" }, include: { order: { include: { user: { select: { id: true, email: true, fullName: true } } } }, refunds: true } });
    if (!payment || payment.order.status !== "PAID") throw conflict("ORDER_NOT_REFUNDABLE", "Only a paid order can be marked as manually refunded.");
    const alreadyRefunded = payment.refunds.reduce((sum, refund) => sum + Number(refund.amount), 0);
    const remaining = Number((Number(payment.amount) - alreadyRefunded).toFixed(2));
    if (remaining <= 0) throw conflict("ORDER_ALREADY_REFUNDED", "This order has already been fully refunded.");
    const amount = Number(input.amount.toFixed(2));
    if (amount <= 0 || amount > remaining) throw badRequest("INVALID_REFUND_AMOUNT", `The refund amount must be between 0.01 and ${remaining.toFixed(2)}.`);
    const fullyRefunded = Number((alreadyRefunded + amount).toFixed(2)) >= Number(payment.amount);
    const isFullRefundAction = amount >= Number(payment.amount);
    const now = new Date();
    const providerRefundId = `MANUAL-${randomUUID()}`;
    const refund = await tx.paymentRefund.create({ data: { paymentId: payment.id, providerRefundId, amount, reason: input.reason, idempotencyKey: input.idempotencyKey } });
    if (fullyRefunded) await tx.payment.update({ where: { id: payment.id }, data: { status: "REFUNDED" } });
    await tx.order.update({ where: { id: orderId }, data: { refundStatus: fullyRefunded ? "FULL" : "PARTIAL", ...(fullyRefunded ? { status: "REFUNDED", refundedAt: now, accessStatus: "REVOKED" } : {}) } });
    if (fullyRefunded) await tx.entitlement.updateMany({ where: { orderId, status: "ACTIVE" }, data: { status: "REVOKED", revokedAt: now, reason: `Manual refund confirmed: ${input.reason}` } });
    await tx.systemAuditLog.create({ data: { actorId, action: "ORDER_REFUNDED", entityType: "Order", entityId: orderId, description: `Confirmed ${isFullRefundAction ? "full" : "partial"} manual refund for order ${payment.order.orderNumber}.`, metadata: { amount, refundType: isFullRefundAction ? "FULL" : "PARTIAL", orderRefundStatus: fullyRefunded ? "FULL" : "PARTIAL", remainingAfterRefund: Math.max(0, Number((remaining - amount).toFixed(2))), providerRefundId, reason: input.reason, processing: "MANUAL_EXTERNAL" } } });
    await enqueueUserLifecycleEmail(tx, {
      deduplicationKey: `refund:${refund.id}`,
      recipientEmail: payment.order.user.email,
      userName: payment.order.user.fullName,
      event: "REFUND_ISSUED",
      occurredAt: refund.createdAt.toISOString(),
      details: { amount: amount.toFixed(2), currency: payment.order.currency, reason: input.reason, orderNumber: payment.order.orderNumber, refundType: isFullRefundAction ? "Full refund" : "Partial refund" },
    });
    const sourceKey = `order-refund:${refund.id}`;
    await createLearnerNotification({ userId: payment.order.user.id, category: "ACCOUNT", title: isFullRefundAction ? "Order refunded" : "Partial refund confirmed", body: `${isFullRefundAction ? "A full refund" : "A partial refund"} of ${payment.order.currency} ${amount.toFixed(2)} for order ${payment.order.orderNumber} has been confirmed.${fullyRefunded && !isFullRefundAction ? " The order is now fully refunded." : ""}`, sourceKey, data: { url: `/receipt/${orderId}`, orderId, status: fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED", refundType: isFullRefundAction ? "FULL" : "PARTIAL", amount, currency: payment.order.currency }, required: true }, tx);
    await enqueueJob({ kind: "LEARNER_PUSH_DELIVERY", payload: { sourceKey }, deduplicationKey: sourceKey }, tx);
    return refund;
  }, { isolationLevel: "Serializable" });
}

export async function cancelAdminOrder(actorId: string, orderId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const changed = await tx.order.updateMany({ where: { id: orderId, status: { in: ["CREATED", "FAILED"] } }, data: { status: "CANCELLED", accessStatus: "NOT_APPLICABLE" } });
    if (!changed.count) throw conflict("ORDER_NOT_CANCELLABLE", "Only created or failed orders can be cancelled.");
    await tx.payment.updateMany({ where: { orderId, status: "PENDING" }, data: { status: "FAILED", failureReason: `Cancelled by administrator: ${reason}` } });
    await tx.systemAuditLog.create({ data: { actorId, action: "ORDER_CANCELLED", entityType: "Order", entityId: orderId, description: `Cancelled order: ${reason}.` } });
    return tx.order.findUniqueOrThrow({ where: { id: orderId } });
  });
}

const sensitiveKey = /password|secret|token|authorization|cookie|api[-_]?key|credential|signature/i;
function redactAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : redactAuditValue(nested)]));
  return value;
}

export async function listAuditEvents(input: { page: number; limit: number; cursor?: string; actorId?: string; academyId?: string; action?: string; entityType?: string; from?: Date; to?: Date }) {
  const where = { ...(input.actorId ? { actorId: input.actorId } : {}), ...(input.academyId ? { academyId: input.academyId } : {}), ...(input.action ? { action: input.action } : {}), ...(input.entityType ? { entityType: input.entityType } : {}), ...((input.from || input.to) ? { occurredAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } } : {}) };
  const [rows, total] = await Promise.all([prisma.systemAuditLog.findMany({ where, ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : { skip: (input.page - 1) * input.limit }), take: input.limit + 1, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], include: { actor: { select: { id: true, email: true, fullName: true } }, academy: { select: { id: true, name: true } } } }), prisma.systemAuditLog.count({ where })]);
  const hasMore = rows.length > input.limit; const selected = rows.slice(0, input.limit);
  return { data: selected.map((event) => ({ ...event, before: redactAuditValue(event.before), after: redactAuditValue(event.after), metadata: redactAuditValue(event.metadata) })), pagination: { page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit), hasMore, nextCursor: hasMore ? selected.at(-1)?.id ?? null : null } };
}

type SecurityEventFilter = "LOGIN_SUCCESS" | "LOGIN_FAILED" | "LOGOUT" | "SESSION_CREATED" | "SESSION_REVOKED" | "PASSWORD_CHANGED" | "ACCOUNT_DISABLED" | "ACCOUNT_ENABLED" | "SUSPICIOUS_ACTIVITY" | "QR_AUTH_SUCCESS" | "QR_AUTH_FAILED";
export async function listSecurityEvents(input: { page: number; limit: number; cursor?: string; riskLevel?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; eventType?: SecurityEventFilter; academyId?: string }) {
  const where = { ...(input.riskLevel ? { riskLevel: input.riskLevel } : {}), ...(input.eventType ? { eventType: input.eventType } : {}), ...(input.academyId ? { academyId: input.academyId } : {}) };
  const [rows, total] = await Promise.all([prisma.securityEvent.findMany({ where, ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : { skip: (input.page - 1) * input.limit }), take: input.limit + 1, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], select: { id: true, eventType: true, riskLevel: true, description: true, ipAddress: true, userAgent: true, sessionId: true, userId: true, actorId: true, academyId: true, occurredAt: true } }), prisma.securityEvent.count({ where })]);
  const hasMore = rows.length > input.limit; const data = rows.slice(0, input.limit);
  return { data, pagination: { page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit), hasMore, nextCursor: hasMore ? data.at(-1)?.id ?? null : null } };
}
