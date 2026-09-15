import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { badRequest, forbidden, notFound } from "../errors/api-error.js";
import { getRewardWallet } from "./rewardService.js";
import { createLearnerNotification } from "./learnerNotificationService.js";

export async function getBootstrap(userId: string, sessionId: string) {
  const now = new Date();
  const [user, session, memberships, activeAcademy, activeEntitlementCount, preference, rewardWallet] = await Promise.all([
    prisma.user.findFirst({
      where: { id: userId, status: "ACTIVE", deletedAt: null },
      select: { id: true, email: true, fullName: true, phone: true, avatarStoragePath: true, role: { select: { key: true } } },
    }),
    prisma.userSession.findFirst({
      where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true, platform: true, expiresAt: true },
    }),
    prisma.academyMembership.findMany({
      where: { userId, role: "ACADEMY_STUDENT", status: "ACTIVE", academy: { status: "ACTIVE", deletedAt: null } },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
      take: 200,
      select: { academyId: true, joinedAt: true, academy: { select: { id: true, name: true, slug: true, logoUrl: true } } },
    }),
    getActiveAcademy(userId),
    prisma.entitlement.count({
      where: { userId, status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    }),
    prisma.learnerPreference.findUnique({
      where: { userId },
      include: { selectedCourse: { select: { id: true, code: true, name: true, slug: true } } },
    }),
    getRewardWallet(userId),
  ]);

  if (!user) throw notFound("USER_NOT_FOUND", "The current user was not found.");
  if (!session) throw forbidden("SESSION_NOT_ACTIVE", "The current session is no longer active.");

  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      avatarStoragePath: user.avatarStoragePath,
      role: "student" as const,
    },
    session,
    activeAcademy: activeAcademy?.academy ?? null,
    memberships: memberships.map((membership) => ({
      academyId: membership.academyId,
      joinedAt: membership.joinedAt,
      academy: membership.academy,
    })),
    accessSummary: {
      planLabel: activeEntitlementCount > 0 ? "PAID" as const : "FREE" as const,
      activeEntitlementCount,
    },
    rewardWallet,
    preference,
    serverTime: now,
  };
}

export async function getProfile(userId: string) {
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true, email: true, fullName: true, phone: true, avatarStoragePath: true, status: true, createdAt: true, updatedAt: true, role: { select: { key: true, name: true } }, activeAcademyPreference: { include: { academy: { select: { id: true, name: true, slug: true } } } } } });
  if (!user) throw notFound("USER_NOT_FOUND", "The current user was not found.");
  return user;
}
export async function updateProfile(userId: string, input: { fullName?: string; phone?: string | null }) {
  const updated = await prisma.user.update({ where: { id: userId }, data: { ...(input.fullName !== undefined ? { fullName: input.fullName.trim() } : {}), ...(input.phone !== undefined ? { phone: input.phone?.trim() ?? null } : {}) }, select: { id: true, email: true, fullName: true, phone: true, updatedAt: true } });
  void createLearnerNotification({ userId, category: "ACCOUNT", title: "Profile updated", body: "Your Parallax Flow account details were changed.", sourceKey: `account-profile:${updated.updatedAt.toISOString()}`, data: { url: "/(student)/account" } }).catch(() => undefined);
  return updated;
}
export async function getMemberships(userId: string) {
  const data = await prisma.academyMembership.findMany({ where: { userId, role: "ACADEMY_STUDENT", status: "ACTIVE", academy: { status: "ACTIVE", deletedAt: null } }, orderBy: [{ joinedAt: "asc" }, { id: "asc" }], take: 200, include: { academy: { select: { id: true, name: true, slug: true, description: true, logoUrl: true, city: true, state: true } } } });
  return { data };
}
export async function getActiveAcademy(userId: string) {
  const preference = await prisma.userAcademyPreference.findUnique({ where: { userId }, include: { academy: { select: { id: true, name: true, slug: true, logoUrl: true } } } });
  if (preference && await prisma.academyMembership.findFirst({ where: { userId, academyId: preference.academyId, role: "ACADEMY_STUDENT", status: "ACTIVE", academy: { status: "ACTIVE", deletedAt: null } } })) return preference;
  const first = await prisma.academyMembership.findFirst({ where: { userId, role: "ACADEMY_STUDENT", status: "ACTIVE", academy: { status: "ACTIVE", deletedAt: null } }, orderBy: [{ joinedAt: "asc" }, { id: "asc" }], include: { academy: { select: { id: true, name: true, slug: true, logoUrl: true } } } });
  return first ? { userId, academyId: first.academyId, academy: first.academy } : null;
}
export async function setActiveAcademy(userId: string, academyId: string) {
  const membership = await prisma.academyMembership.findFirst({ where: { userId, academyId, role: "ACADEMY_STUDENT", status: "ACTIVE", academy: { status: "ACTIVE", deletedAt: null } } });
  if (!membership) throw forbidden("ACADEMY_MEMBERSHIP_REQUIRED", "An active student membership is required for this academy.");
  return prisma.userAcademyPreference.upsert({ where: { userId }, create: { userId, academyId }, update: { academyId }, include: { academy: { select: { id: true, name: true, slug: true } } } });
}
async function academyIdFor(userId: string, requested?: string) {
  if (requested) { await setActiveAcademy(userId, requested); return requested; }
  const active = await getActiveAcademy(userId);
  if (!active) throw badRequest("ACTIVE_ACADEMY_REQUIRED", "Select or join an academy before accessing this resource.");
  return active.academyId;
}
export async function getDashboard(userId: string, requestedAcademyId?: string) {
  const academyId = await academyIdFor(userId, requestedAcademyId);
  const [courses, unreadNotifications, activeEntitlements, recentOrders] = await Promise.all([
    prisma.academyCourseEnrollment.count({ where: { studentId: userId, academyId, status: "ACTIVE" } }),
    prisma.notificationRecipient.count({ where: { studentUserId: userId, academyId, isRead: false, notification: { status: "SENT", deletedAt: null } } }),
    prisma.entitlement.count({ where: { userId, status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }], course: { academyId } } }),
    prisma.order.findMany({ where: { userId, course: { academyId } }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, orderNumber: true, status: true, totalAmount: true, currency: true, createdAt: true } }),
  ]);
  return { academyId, courses, unreadNotifications, activeEntitlements, recentOrders: recentOrders.map((order) => ({ ...order, totalAmount: Number(order.totalAmount) })) };
}
export async function listCourses(userId: string, requestedAcademyId?: string) {
  const academyId = await academyIdFor(userId, requestedAcademyId);
  const courses = await prisma.course.findMany({ where: { academyId, status: "ACTIVE", deletedAt: null }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 500, include: { _count: { select: { contentItems: true, packages: true } }, enrollments: { where: { studentId: userId, status: "ACTIVE" }, take: 1, select: { id: true, status: true, enrolledAt: true } } } });
  return { academyId, data: courses.map(({ enrollments, ...course }) => ({ id: enrollments[0]?.id ?? `membership:${course.id}`, academyId, studentId: userId, courseId: course.id, status: "ACTIVE" as const, enrolledAt: enrollments[0]?.enrolledAt ?? null, course })) };
}
export async function getCourse(userId: string, courseId: string) {
  const course = await prisma.course.findFirst({ where: { id: courseId, status: "ACTIVE", deletedAt: null, academy: { status: "ACTIVE", deletedAt: null, memberships: { some: { userId, role: "ACADEMY_STUDENT", status: "ACTIVE" } } } }, include: { subjects: { where: { deletedAt: null }, orderBy: { name: "asc" } }, packages: { where: { status: "PUBLISHED", deletedAt: null }, orderBy: { title: "asc" } } } });
  if (!course) throw notFound("ACADEMY_COURSE_NOT_FOUND", "The academy course was not found or is unavailable to this account.");
  return { id: `membership:${course.id}`, academyId: course.academyId!, studentId: userId, courseId: course.id, status: "ACTIVE" as const, enrolledAt: null, course: { ...course, packages: course.packages.map((item) => ({ ...item, price: Number(item.price) })) } };
}
export async function listCourseContent(userId: string, courseId: string, parentId?: string | null) {
  await getCourse(userId, courseId);
  const [entitlements, preference] = await Promise.all([
    prisma.entitlement.findMany({ where: { userId, status: "ACTIVE", AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, { OR: [{ courseId }, { package: { courseId } }, { contentItem: { courseId } }] }] }, take: 5_000, select: { contentItemId: true, package: { select: { items: { take: 5_000, select: { contentItemId: true } } } }, courseId: true } }),
    prisma.learnerPreference.findUnique({ where: { userId }, select: { examDate: true } }),
  ]);
  const entitled = new Set(entitlements.flatMap((entry) => [...(entry.contentItemId ? [entry.contentItemId] : []), ...(entry.package?.items.map((item) => item.contentItemId) ?? [])]));
  const courseAccess = entitlements.some((entry) => entry.courseId === courseId);
  const rows = await prisma.contentItem.findMany({ where: { courseId, parentId: parentId ?? null, status: "PUBLISHED", deletedAt: null }, orderBy: [{ displayOrder: "asc" }, { name: "asc" }], take: 500, select: { id: true, parentId: true, kind: true, name: true, description: true, entityType: true, accessType: true, price: true, accessDurationValue: true, accessDurationUnit: true, mimeType: true, size: true, _count: { select: { children: true } } } });
  return { data: rows.map((item) => ({ ...item, size: Number(item.size), price: item.price ? Number(item.price) : null, accessDuration: { value: item.accessDurationValue, unit: item.accessDurationUnit }, accessible: true, expiresAt: null })) };
}
export async function listOrders(userId: string, page: number, limit: number) {
  const where = { userId } satisfies Prisma.OrderWhereInput;
  const [data, total] = await Promise.all([prisma.order.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, orderNumber: true, currency: true, subtotal: true, discountAmount: true, totalAmount: true, status: true, refundStatus: true, accessStatus: true, receiptNumber: true, createdAt: true, paidAt: true } }), prisma.order.count({ where })]);
  return { data: data.map((order) => ({ ...order, subtotal: Number(order.subtotal), discountAmount: Number(order.discountAmount), totalAmount: Number(order.totalAmount) })), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}
export async function getOrder(userId: string, orderId: string) {
  const order = await prisma.order.findFirst({ where: { id: orderId, userId }, include: { items: true, payments: { select: { id: true, provider: true, amount: true, currency: true, status: true, paymentMethod: true, createdAt: true } }, redemptions: { include: { coupon: { select: { code: true } } } } } });
  if (!order) throw notFound("ORDER_NOT_FOUND", "The order was not found.");
  return order;
}
