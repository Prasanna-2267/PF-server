import type { EntitlementStatus, Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { conflict, forbidden, notFound } from "../errors/api-error.js";
import { expandedPackageContentIds, packageRootIds, publishedCourseContent, type PackageContentRecord } from "./packageContentService.js";

const EXPIRING_SOON_MS = 30 * 24 * 60 * 60_000;

type EffectiveStatus = "ACTIVE" | "EXPIRING_SOON" | "EXPIRED" | "REVOKED";

function effectiveStatus(status: EntitlementStatus, expiresAt: Date | null, now = new Date()): EffectiveStatus {
  if (status === "REVOKED") return "REVOKED";
  if (status === "EXPIRED" || (expiresAt && expiresAt <= now)) return "EXPIRED";
  if (expiresAt && expiresAt.getTime() - now.getTime() <= EXPIRING_SOON_MS) return "EXPIRING_SOON";
  return "ACTIVE";
}

function money(value: Prisma.Decimal | null) {
  if (value === null) return null;
  const amount = Number(value);
  return { amount, amountMinor: Math.round(amount * 100), currency: "INR" as const };
}

async function selectedCourse(userId: string) {
  const preference = await prisma.learnerPreference.findUnique({
    where: { userId },
    select: { selectedCourse: { select: { id: true, code: true, name: true, slug: true, description: true, academyId: true, status: true, deletedAt: true, academy: { select: { id: true, name: true, status: true, deletedAt: true } } } } },
  });
  const course = preference?.selectedCourse;
  if (!course || course.status !== "ACTIVE" || course.deletedAt || (course.academy && (course.academy.status !== "ACTIVE" || course.academy.deletedAt))) {
    throw conflict("COURSE_NOT_SELECTED", "Complete learner personalisation and select an active course first.");
  }
  if (course.academyId && !await prisma.academyMembership.findFirst({ where: { userId, academyId: course.academyId, role: "ACADEMY_STUDENT", status: "ACTIVE" }, select: { id: true } })) {
    throw forbidden("ACADEMY_MEMBERSHIP_REQUIRED", "This academy course is no longer available to your account.");
  }
  return course;
}

const entitlementSelect = {
  id: true,
  resourceType: true,
  contentItemId: true,
  packageId: true,
  subjectId: true,
  courseId: true,
  resourceTitle: true,
  source: true,
  accessType: true,
  status: true,
  grantedAt: true,
  expiresAt: true,
  revokedAt: true,
  reason: true,
  orderId: true,
  order: { select: { orderNumber: true, isComplimentary: true, totalAmount: true, currency: true, paidAt: true, receiptNumber: true } },
  package: { select: { id: true, title: true, slug: true, courseId: true, status: true, deletedAt: true, items: { orderBy: { displayOrder: "asc" as const }, take: 5000, select: { contentItemId: true } }, questionBanks: { take: 5000, select: { questionBankId: true } } } },
  contentItem: { select: { id: true, name: true, courseId: true, status: true, deletedAt: true, mimeType: true, kind: true, accessDurationValue: true, accessDurationUnit: true } },
  course: { select: { id: true, name: true, code: true, status: true, deletedAt: true } },
} satisfies Prisma.EntitlementSelect;

type EntitlementRecord = Prisma.EntitlementGetPayload<{ select: typeof entitlementSelect }>;

function presentEntitlement(item: EntitlementRecord, now = new Date()) {
  return {
    id: item.id,
    resourceType: item.resourceType,
    resourceId: item.contentItemId ?? item.packageId ?? item.subjectId ?? item.courseId,
    title: item.resourceTitle,
    source: item.source,
    accessType: item.accessType,
    status: effectiveStatus(item.status, item.expiresAt, now),
    storedStatus: item.status,
    grantedAt: item.grantedAt,
    expiresAt: item.expiresAt,
    revokedAt: item.revokedAt,
    reason: item.reason,
    order: item.order ? { orderId: item.orderId, orderNumber: item.order.orderNumber, receiptNumber: item.order.receiptNumber, isComplimentary: item.order.isComplimentary, total: money(item.order.totalAmount), paidAt: item.order.paidAt } : null,
  };
}

async function entitlementMaps(userId: string, courseId?: string) {
  const now = new Date();
  const entitlements = await prisma.entitlement.findMany({
    where: { userId, ...(courseId ? { OR: [{ courseId }, { package: { courseId } }, { contentItem: { courseId } }] } : {}) },
    select: entitlementSelect,
    orderBy: [{ grantedAt: "desc" }, { id: "desc" }],
    take: 5000,
  });
  const effective = entitlements.filter((item) => ["ACTIVE", "EXPIRING_SOON"].includes(effectiveStatus(item.status, item.expiresAt, now)));
  const packageIds = new Set<string>();
  const content = new Map<string, EntitlementRecord>();
  let ownsCourse = false;
  for (const item of effective) {
    if (courseId && item.courseId === courseId) ownsCourse = true;
    if (item.packageId) packageIds.add(item.packageId);
    if (item.contentItemId) content.set(item.contentItemId, item);
    for (const packageItem of item.package?.items ?? []) content.set(packageItem.contentItemId, item);
  }
  const packageEntitlements = effective.filter((item) => item.package?.items.length);
  const packageCourses = [...new Set(packageEntitlements.map((item) => item.package!.courseId))];
  const courseContent = new Map((await Promise.all(packageCourses.map(async (id) => [id, await publishedCourseContent(id)] as const))));
  for (const entitlement of packageEntitlements) {
    const packageItem = entitlement.package!;
    const expanded = expandedPackageContentIds(courseContent.get(packageItem.courseId) ?? [], packageItem.items.map((item) => item.contentItemId));
    for (const contentItemId of expanded) content.set(contentItemId, entitlement);
  }
  return { all: entitlements, effective, packageIds, content, ownsCourse };
}

const packageInclude = {
  course: { select: { id: true, code: true, name: true, slug: true, academy: { select: { id: true, name: true } } } },
  items: {
    orderBy: { displayOrder: "asc" as const },
    take: 5000,
    select: {
      id: true,
      displayOrder: true,
      contentItem: { select: { id: true, name: true, description: true, entityType: true, kind: true, mimeType: true, size: true, accessType: true, accessDurationValue: true, accessDurationUnit: true, status: true, deletedAt: true } },
    },
  },
  questionBanks: {
    orderBy: { displayOrder: "asc" as const },
    take: 5000,
    select: {
      id: true,
      displayOrder: true,
      questionBank: {
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          accessType: true,
          price: true,
          status: true,
          deletedAt: true,
          _count: { select: { questions: { where: { status: "PUBLISHED", deletedAt: null } } } },
        },
      },
    },
  },
} satisfies Prisma.PackageInclude;

type PackageRecord = Prisma.PackageGetPayload<{ include: typeof packageInclude }>;

function presentPackage(item: PackageRecord, access: { owned: boolean; source: string | null; expiresAt: Date | null }) {
  const publishedItems = item.items.filter((entry) => entry.contentItem.status === "PUBLISHED" && !entry.contentItem.deletedAt);
  const publishedQuestionBanks = item.questionBanks.filter((entry) => entry.questionBank.status === "PUBLISHED" && !entry.questionBank.deletedAt);
  return {
    id: item.id,
    courseId: item.courseId,
    title: item.title,
    slug: item.slug,
    description: item.description,
    price: money(item.price),
    course: item.course,
    itemCount: publishedItems.length,
    noteCount: publishedItems.length,
    questionBankCount: publishedQuestionBanks.length,
    resourceCount: publishedItems.length + publishedQuestionBanks.length,
    access,
    items: publishedItems.map(({ contentItem, displayOrder }) => ({
      id: contentItem.id,
      title: contentItem.name,
      description: contentItem.description,
      displayOrder,
      entityType: contentItem.entityType,
      kind: contentItem.kind,
      mimeType: contentItem.mimeType,
      sizeBytes: contentItem.size.toString(),
      accessType: contentItem.accessType,
      accessDuration: { value: contentItem.accessDurationValue, unit: contentItem.accessDurationUnit },
    })),
    questionBanks: publishedQuestionBanks.map(({ questionBank, displayOrder }) => ({
      id: questionBank.id,
      title: questionBank.name,
      slug: questionBank.slug,
      description: questionBank.description,
      displayOrder,
      accessType: questionBank.accessType,
      price: money(questionBank.price),
      questionCount: questionBank._count.questions,
      includedByPackage: access.owned,
      practicePath: `/practice?mode=QUESTION_BANK&questionBankId=${encodeURIComponent(questionBank.id)}`,
    })),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function packageAccess(item: PackageRecord, entitlement: ReturnType<typeof entitlementMaps> extends Promise<infer T> ? T : never) {
  const direct = entitlement.effective.find((entry) => entry.packageId === item.id);
  const course = entitlement.effective.find((entry) => entry.courseId === item.courseId);
  const owned = Boolean(direct || course);
  const source = direct ?? course;
  return { owned, source: source?.source ?? null, expiresAt: source?.expiresAt ?? null };
}

export async function listPackages(userId: string, input: { search?: string; ownership: "all" | "owned" | "available"; page: number; limit: number }) {
  const course = await selectedCourse(userId);
  const [entitlements, courseContent] = await Promise.all([
    entitlementMaps(userId, course.id),
    publishedCourseContent(course.id),
  ]);
  const where: Prisma.PackageWhereInput = {
    courseId: course.id,
    status: "PUBLISHED",
    deletedAt: null,
    ...(input.search ? { OR: [{ title: { contains: input.search, mode: "insensitive" } }, { description: { contains: input.search, mode: "insensitive" } }] } : {}),
  };
  const rows = await prisma.package.findMany({ where, include: packageInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1000 });
  const filtered = rows.filter((item) => input.ownership === "all" || (input.ownership === "owned") === packageAccess(item, entitlements).owned);
  const start = (input.page - 1) * input.limit;
  return {
    course: { id: course.id, code: course.code, name: course.name, slug: course.slug },
    items: filtered.slice(start, start + input.limit).map((item) => {
      const presented = presentPackage(item, packageAccess(item, entitlements));
      const includedIds = expandedPackageContentIds(courseContent, item.items.map((entry) => entry.contentItem.id));
      const included = courseContent.filter((entry) => includedIds.has(entry.id));
      return {
        ...presented,
        itemCount: included.filter((entry) => entry.kind === "FILE").length,
        noteCount: included.filter((entry) => entry.kind === "FILE").length,
        folderCount: included.filter((entry) => entry.kind === "FOLDER").length,
        resourceCount: included.filter((entry) => entry.kind === "FILE").length + presented.questionBankCount,
      };
    }),
    pagination: { page: input.page, limit: input.limit, total: filtered.length, pages: Math.ceil(filtered.length / input.limit) },
  };
}

export async function getPackage(userId: string, packageId: string) {
  const course = await selectedCourse(userId);
  const item = await prisma.package.findFirst({ where: { id: packageId, courseId: course.id, status: "PUBLISHED", deletedAt: null }, include: packageInclude });
  if (!item) throw notFound("PACKAGE_NOT_FOUND", "The published package was not found in your selected course.");
  const entitlements = await entitlementMaps(userId, course.id);
  const presented = presentPackage(item, packageAccess(item, entitlements));
  const courseContent = await publishedCourseContent(item.courseId);
  const selectedIds = item.items.map((entry) => entry.contentItem.id);
  const includedIds = expandedPackageContentIds(courseContent, selectedIds);
  const included = courseContent.filter((entry) => includedIds.has(entry.id));
  const roots = packageRootIds(courseContent, selectedIds);
  const nodes = new Map<string, PackageContentNode>(included.map((contentItem) => [contentItem.id, presentPackageContent(contentItem)]));
  for (const contentItem of included) {
    const node = nodes.get(contentItem.id)!;
    const parent = contentItem.parentId ? nodes.get(contentItem.parentId) : undefined;
    if (parent) parent.children.push(node);
  }
  const contentTree = roots.flatMap((id) => nodes.get(id) ? [nodes.get(id)!] : []);
  return {
    ...presented,
    itemCount: included.filter((entry) => entry.kind === "FILE").length,
    noteCount: included.filter((entry) => entry.kind === "FILE").length,
    folderCount: included.filter((entry) => entry.kind === "FOLDER").length,
    resourceCount: included.filter((entry) => entry.kind === "FILE").length + presented.questionBankCount,
    contentTree,
  };
}

type PackageContentNode = {
  id: string;
  parentId: string | null;
  kind: "FILE" | "FOLDER";
  title: string;
  description: string | null;
  entityType: string;
  mimeType: string | null;
  sizeBytes: string;
  children: PackageContentNode[];
};

function presentPackageContent(item: PackageContentRecord): PackageContentNode {
  return { id: item.id, parentId: item.parentId, kind: item.kind, title: item.name, description: item.description, entityType: item.entityType ?? item.kind, mimeType: item.mimeType, sizeBytes: item.size.toString(), children: [] };
}

export async function listEntitlements(userId: string, input: { status?: EffectiveStatus; page: number; limit: number }) {
  const entitlements = await entitlementMaps(userId);
  const items = entitlements.all.map((item) => presentEntitlement(item)).filter((item) => !input.status || item.status === input.status);
  const start = (input.page - 1) * input.limit;
  return { items: items.slice(start, start + input.limit), pagination: { page: input.page, limit: input.limit, total: items.length, pages: Math.ceil(items.length / input.limit) }, serverTime: new Date() };
}

export async function getEntitlement(userId: string, entitlementId: string) {
  const item = await prisma.entitlement.findFirst({ where: { id: entitlementId, userId }, select: entitlementSelect });
  if (!item) throw notFound("ENTITLEMENT_NOT_FOUND", "The entitlement was not found.");
  return { ...presentEntitlement(item), serverTime: new Date() };
}

export async function getLibrary(userId: string, input: { page: number; limit: number }) {
  const now = new Date();
  const [entitlements, orderCounts] = await Promise.all([
    entitlementMaps(userId),
    prisma.order.groupBy({ by: ["isComplimentary"], where: { userId, status: "PAID" }, _count: { _all: true } }),
  ]);
  const active = entitlements.effective;
  const courseIds = active.flatMap((item) => item.courseId ? [item.courseId] : []);
  // entitlementMaps expands package folders recursively, so every owned descendant
  // is included here rather than only the folder selected by the administrator.
  const contentIds = new Set(entitlements.content.keys());
  const where: Prisma.ContentItemWhereInput = {
    kind: "FILE",
    mimeType: { in: ["application/pdf", "image/jpeg", "image/png", "image/webp"] },
    status: "PUBLISHED",
    deletedAt: null,
    OR: [{ id: { in: [...contentIds] } }, ...(courseIds.length ? [{ courseId: { in: courseIds } }] : [])],
  };
  const [rows, total] = contentIds.size || courseIds.length ? await Promise.all([
    prisma.contentItem.findMany({
      where,
      skip: (input.page - 1) * input.limit,
      take: input.limit,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { id: true, courseId: true, name: true, description: true, entityType: true, mimeType: true, size: true, accessDurationValue: true, accessDurationUnit: true, updatedAt: true, course: { select: { id: true, code: true, name: true } }, learnerStates: { where: { userId }, take: 1, select: { completed: true, favourite: true, progressPercent: true, currentPage: true, lastOpenedAt: true, revisionCount: true } } },
    }),
    prisma.contentItem.count({ where }),
  ]) : [[], 0] as const;
  const freePurchases = orderCounts.find((entry) => entry.isComplimentary)?._count._all ?? 0;
  const paidPurchases = orderCounts.find((entry) => !entry.isComplimentary)?._count._all ?? 0;
  return {
    summary: { owned: total, freePurchases, paidPurchases, activeEntitlements: active.length, expiringSoon: active.filter((item) => effectiveStatus(item.status, item.expiresAt, now) === "EXPIRING_SOON").length },
    items: rows.map((item) => {
      const entitlement = entitlements.content.get(item.id) ?? active.find((entry) => entry.courseId === item.courseId);
      const expiresAt = entitlement?.expiresAt ?? null;
      const status = entitlement ? effectiveStatus(entitlement.status, expiresAt, now) : "ACTIVE";
      return { id: item.id, title: item.name, description: item.description, entityType: item.entityType, mimeType: item.mimeType, sizeBytes: item.size.toString(), accessDuration: { value: item.accessDurationValue, unit: item.accessDurationUnit }, course: item.course, state: item.learnerStates[0] ?? { completed: false, favourite: false, progressPercent: 0, currentPage: null, lastOpenedAt: null, revisionCount: 0 }, access: { source: entitlement?.source ?? "PURCHASE", expiresAt, status }, updatedAt: item.updatedAt };
    }),
    pagination: { page: input.page, limit: input.limit, total, pages: Math.ceil(total / input.limit) },
    serverTime: now,
  };
}

export async function listStoreResources(userId: string, input: { search?: string; type: "all" | "note" | "package"; page: number; limit: number }) {
  const course = await selectedCourse(userId);
  const entitlements = await entitlementMaps(userId, course.id);
  const search = input.search?.trim();
  const [packages, notes] = await Promise.all([
    input.type === "note" ? Promise.resolve([]) : prisma.package.findMany({ where: { courseId: course.id, status: "PUBLISHED", deletedAt: null, ...(search ? { OR: [{ title: { contains: search, mode: "insensitive" } }, { description: { contains: search, mode: "insensitive" } }] } : {}) }, include: packageInclude, orderBy: { createdAt: "desc" }, take: 1000 }),
    input.type === "package" ? Promise.resolve([]) : prisma.contentItem.findMany({ where: { courseId: course.id, kind: "FILE", status: "PUBLISHED", deletedAt: null, accessType: "PAID", NOT: { entityType: "MONTHLY_REPORT" }, ...(search ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { description: { contains: search, mode: "insensitive" } }] } : {}) }, select: { id: true, name: true, description: true, entityType: true, mimeType: true, size: true, price: true, accessDurationValue: true, accessDurationUnit: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 1000 }),
  ]);
  const resources = [
    ...packages.map((item) => ({ type: "package" as const, id: item.id, title: item.title, description: item.description, price: money(item.price), itemCount: item.items.length, access: packageAccess(item, entitlements), createdAt: item.createdAt })),
    ...notes.map((item) => { const owned = entitlements.ownsCourse || entitlements.content.has(item.id); const source = entitlements.content.get(item.id) ?? entitlements.effective.find((entry) => entry.courseId === course.id); return { type: "note" as const, id: item.id, title: item.name, description: item.description, price: money(item.price), entityType: item.entityType, mimeType: item.mimeType, sizeBytes: item.size.toString(), accessDuration: { value: item.accessDurationValue, unit: item.accessDurationUnit }, access: { owned, source: source?.source ?? null, expiresAt: source?.expiresAt ?? null }, createdAt: item.createdAt }; }),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const start = (input.page - 1) * input.limit;
  return { course: { id: course.id, code: course.code, name: course.name }, items: resources.slice(start, start + input.limit), pagination: { page: input.page, limit: input.limit, total: resources.length, pages: Math.ceil(resources.length / input.limit) } };
}

export async function getReceipt(userId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: {
      id: true,
      orderNumber: true,
      receiptNumber: true,
      currency: true,
      subtotal: true,
      discountAmount: true,
      totalAmount: true,
      status: true,
      refundStatus: true,
      accessStatus: true,
      isComplimentary: true,
      paymentMethod: true,
      createdAt: true,
      paidAt: true,
      refundedAt: true,
      user: { select: { fullName: true, email: true, phone: true } },
      course: { select: { id: true, code: true, name: true } },
      items: { orderBy: { id: "asc" }, select: { id: true, resourceType: true, contentItemId: true, packageId: true, titleSnapshot: true, unitPrice: true, quantity: true, totalPrice: true } },
      payments: { where: { status: { in: ["SUCCESS", "REFUNDED"] } }, orderBy: { createdAt: "desc" }, select: { id: true, provider: true, providerPaymentId: true, amount: true, currency: true, status: true, paymentMethod: true, createdAt: true, refunds: { orderBy: { createdAt: "desc" }, select: { id: true, providerRefundId: true, amount: true, reason: true, createdAt: true } } } },
      redemptions: { select: { discountAmount: true, coupon: { select: { code: true, discountType: true, discountValue: true } } } },
    },
  });
  if (!order) throw notFound("ORDER_NOT_FOUND", "The receipt was not found.");
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    receiptNumber: order.receiptNumber,
    status: order.status,
    refundStatus: order.refundStatus,
    accessStatus: order.accessStatus,
    purchaseType: order.isComplimentary ? "FREE_PURCHASE" as const : "PAID_PURCHASE" as const,
    customer: order.user,
    course: order.course,
    totals: { subtotal: money(order.subtotal), discount: money(order.discountAmount), total: money(order.totalAmount) },
    paymentMethod: order.paymentMethod,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    refundedAt: order.refundedAt,
    items: order.items.map((item) => ({ ...item, unitPrice: money(item.unitPrice), totalPrice: money(item.totalPrice) })),
    payments: order.payments.map((payment) => ({ ...payment, amount: money(payment.amount), refunds: payment.refunds.map((refund) => ({ ...refund, amount: money(refund.amount) })) })),
    coupons: order.redemptions.map((redemption) => ({ code: redemption.coupon.code, discountType: redemption.coupon.discountType, discountValue: Number(redemption.coupon.discountValue), discount: money(redemption.discountAmount) })),
  };
}
