import { randomUUID } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.js";
import { type TenantContext } from "../auth/tenant-auth.js";
import { prisma } from "../db/prisma.js";
import { badRequest, conflict, notFound } from "../errors/api-error.js";
import { sanitizeRichText } from "../utils/sanitize-html.js";
import { enqueueJob } from "./backgroundJobService.js";
import { dispatchQueuedNotification } from "./academyNotificationService.js";
import { getStudentConceptInsights } from "./studentPerformanceService.js";

export interface PageInput { page?: number; limit?: number }
const paging = (input: PageInput) => ({ page: input.page ?? 1, limit: input.limit ?? 25 });
const requiredAcademyId = (context: TenantContext): string => {
  if (!context.academyId) throw badRequest("ACADEMY_CONTEXT_REQUIRED", "An active academy context is required.");
  return context.academyId;
};
const pageResult = <T>(data: T[], total: number, page: number, limit: number) => ({
  data,
  pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
});
const writeAudit = (transaction: Prisma.TransactionClient, input: {
  action: string; entityType: string; entityId: string; academyId: string; actorId: string;
  description: string; before?: Prisma.InputJsonValue; after?: Prisma.InputJsonValue; metadata?: Prisma.InputJsonValue;
}) => transaction.systemAuditLog.create({ data: input });

export async function getAcademyOverview(context: TenantContext) {
  const academyId = requiredAcademyId(context);
  const [studentCount, activeStudentCount, courseCount, activeCourseCount, contentCount, questionCount, activeBroadcastCount, academy, recentActivity] = await Promise.all([
    prisma.academyMembership.count({ where: { academyId, role: "ACADEMY_STUDENT" } }),
    prisma.academyMembership.count({ where: { academyId, role: "ACADEMY_STUDENT", status: "ACTIVE" } }),
    prisma.course.count({ where: { academyId, deletedAt: null } }),
    prisma.course.count({ where: { academyId, status: "ACTIVE", deletedAt: null } }),
    prisma.contentItem.count({ where: { course: { academyId }, deletedAt: null } }),
    prisma.question.count({ where: { academyId, deletedAt: null } }),
    prisma.broadcast.count({ where: { academyId, status: { in: ["ACTIVE", "SCHEDULED"] }, deletedAt: null } }),
    prisma.academy.findFirst({ where: { id: academyId, deletedAt: null }, select: { id: true, name: true, slug: true, email: true, phone: true, status: true } }),
    prisma.systemAuditLog.findMany({
      where: { academyId }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 10,
      select: { id: true, action: true, entityType: true, entityId: true, description: true, occurredAt: true },
    }),
  ]);
  if (!academy) throw notFound("ACADEMY_NOT_FOUND", "The academy was not found.");
  return {
    academy,
    metrics: { studentCount, activeStudentCount, courseCount, activeCourseCount, contentCount, questionCount, activeBroadcastCount },
    recentActivity: recentActivity.map((event) => ({ ...event, timestamp: event.occurredAt.toISOString() })),
  };
}

export async function getAcademyStudents(
  context: TenantContext,
  params: PageInput & { search?: string; status?: "ACTIVE" | "INVITED" | "SUSPENDED" | "REVOKED"; accountStatus?: "ACTIVE" | "DISABLED" },
) {
  const academyId = requiredAcademyId(context);
  const { page, limit } = paging(params);
  const where: Prisma.AcademyMembershipWhereInput = {
    academyId, role: "ACADEMY_STUDENT",
    ...(params.status ? { status: params.status } : {}),
    ...((params.search || params.accountStatus) ? { user: {
      ...(params.accountStatus ? { status: params.accountStatus } : {}),
      ...(params.search ? { OR: [
        { fullName: { contains: params.search, mode: "insensitive" } },
        { email: { contains: params.search, mode: "insensitive" } },
        { phone: { contains: params.search, mode: "insensitive" } },
      ] } : {}),
    } } : {}),
  };
  const [memberships, total] = await Promise.all([
    prisma.academyMembership.findMany({
      where, skip: (page - 1) * limit, take: limit, orderBy: [{ joinedAt: "desc" }, { id: "desc" }],
      select: { id: true, userId: true, status: true, joinedAt: true, user: { select: { fullName: true, email: true, phone: true, status: true, avatarStoragePath: true, lastLoginAt: true } } },
    }),
    prisma.academyMembership.count({ where }),
  ]);
  return pageResult(memberships.map((membership) => ({
    id: membership.id, studentId: membership.userId, name: membership.user.fullName,
    email: membership.user.email, phone: membership.user.phone, membershipStatus: membership.status,
    accountStatus: membership.user.status, avatarStoragePath: membership.user.avatarStoragePath,
    joinedAt: membership.joinedAt.toISOString(), lastLoginAt: membership.user.lastLoginAt?.toISOString() ?? null,
  })), total, page, limit);
}

export async function getAcademyStudentDetail(context: TenantContext, studentUserId: string) {
  const academyId = requiredAcademyId(context);
  const membership = await prisma.academyMembership.findFirst({
    where: { academyId, userId: studentUserId, role: "ACADEMY_STUDENT" },
    select: { userId: true, status: true, joinedAt: true, user: { select: { fullName: true, email: true, phone: true, status: true, avatarStoragePath: true, lastLoginAt: true } } },
  });
  if (!membership) throw notFound("STUDENT_NOT_FOUND", "The student does not belong to this academy.");
  const enrollments = await prisma.academyCourseEnrollment.findMany({
    where: { academyId, studentId: studentUserId }, take: 100,
    orderBy: [{ enrolledAt: "desc" }, { id: "desc" }],
    select: { id: true, courseId: true, status: true, enrolledAt: true, completedAt: true, course: { select: { name: true, code: true } } },
  });
  return { student: { id: membership.userId, ...membership.user, membershipStatus: membership.status, joinedAt: membership.joinedAt }, enrollments, performanceInsights: await getStudentConceptInsights(studentUserId, { academyId }) };
}

export async function inviteAcademyStudent(context: TenantContext, payload: { email: string; studentName?: string }) {
  const academyId = requiredAcademyId(context);
  const email = payload.email.trim().toLowerCase();
  return prisma.$transaction(async (transaction) => {
    const [membership, pendingInvitation] = await Promise.all([
      transaction.academyMembership.findFirst({ where: { academyId, user: { email }, status: { not: "REVOKED" } }, select: { id: true } }),
      transaction.academyInvitation.findFirst({ where: { academyId, email, status: "PENDING" }, select: { id: true } }),
    ]);
    if (membership) throw conflict("STUDENT_ALREADY_MEMBER", "This user already has an academy membership.");
    if (pendingInvitation) throw conflict("INVITATION_ALREADY_PENDING", "A pending invitation already exists for this email.");
    const invitation = await transaction.academyInvitation.create({ data: {
      academyId, email, studentName: payload.studentName?.trim() ?? "", role: "ACADEMY_STUDENT",
      status: "PENDING", invitedBy: context.user.id, expiresAt: new Date(Date.now() + 7 * 86_400_000),
    } });
    await writeAudit(transaction, { action: "STUDENT_INVITED", entityType: "AcademyInvitation", entityId: invitation.id, academyId, actorId: context.user.id, description: `Created student invitation for ${email}.` });
    return { ...invitation, deliveryStatus: "EMAIL_PROVIDER_NOT_CONFIGURED" as const };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function updateAcademyStudentStatus(context: TenantContext, studentUserId: string, status: "ACTIVE" | "SUSPENDED" | "REVOKED") {
  const academyId = requiredAcademyId(context);
  return prisma.$transaction(async (transaction) => {
    const membership = await transaction.academyMembership.findFirst({ where: { academyId, userId: studentUserId, role: "ACADEMY_STUDENT" } });
    if (!membership) throw notFound("STUDENT_NOT_FOUND", "The student membership was not found.");
    const updated = await transaction.academyMembership.update({ where: { id: membership.id }, data: { status } });
    await writeAudit(transaction, { action: "STUDENT_STATUS_CHANGED", entityType: "AcademyMembership", entityId: updated.id, academyId, actorId: context.user.id, description: `Changed student membership status to ${status}.`, before: { status: membership.status }, after: { status } });
    return updated;
  });
}

export async function enrollStudentInCourse(context: TenantContext, studentUserId: string, courseId: string) {
  const academyId = requiredAcademyId(context);
  return prisma.$transaction(async (transaction) => {
    const [student, course] = await Promise.all([
      transaction.academyMembership.findFirst({ where: { academyId, userId: studentUserId, role: "ACADEMY_STUDENT", status: "ACTIVE" }, select: { id: true } }),
      transaction.course.findFirst({ where: { id: courseId, academyId, deletedAt: null, status: "ACTIVE" }, select: { id: true } }),
    ]);
    if (!student) throw notFound("ACTIVE_STUDENT_NOT_FOUND", "An active student membership was not found in this academy.");
    if (!course) throw notFound("ACTIVE_COURSE_NOT_FOUND", "An active course was not found in this academy.");
    const enrollment = await transaction.academyCourseEnrollment.upsert({
      where: { studentId_courseId: { studentId: studentUserId, courseId } },
      create: { academyId, studentId: studentUserId, courseId, status: "ACTIVE" },
      update: { academyId, status: "ACTIVE", completedAt: null },
    });
    await writeAudit(transaction, { action: "STUDENT_ENROLLED", entityType: "AcademyCourseEnrollment", entityId: enrollment.id, academyId, actorId: context.user.id, description: "Activated a course enrollment." });
    return enrollment;
  });
}

export async function getAcademyCourses(context: TenantContext, input: PageInput & { includeArchived?: boolean; search?: string; status?: "ACTIVE" | "INACTIVE" | "ARCHIVED"; sort?: "newest" | "oldest" | "name_asc" | "name_desc" } = {}) {
  const academyId = requiredAcademyId(context);
  const { page, limit } = paging(input);
  const where = { academyId, ...(input.includeArchived ? {} : { deletedAt: null }), ...(input.status ? { status: input.status } : {}), ...(input.search ? { OR: [{ name: { contains: input.search, mode: "insensitive" as const } }, { code: { contains: input.search, mode: "insensitive" as const } }, { description: { contains: input.search, mode: "insensitive" as const } }] } : {}) } satisfies Prisma.CourseWhereInput;
  const orderBy: Prisma.CourseOrderByWithRelationInput[] = input.sort === "oldest" ? [{ createdAt: "asc" }, { id: "asc" }] : input.sort === "name_asc" ? [{ name: "asc" }, { id: "asc" }] : input.sort === "name_desc" ? [{ name: "desc" }, { id: "desc" }] : [{ createdAt: "desc" }, { id: "desc" }];
  const [courses, total, totalCourses, activeCourses, uniqueEnrolledStudents, totalContentItems] = await Promise.all([
    prisma.course.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy, include: { _count: { select: { contentItems: { where: { deletedAt: null } }, questions: { where: { deletedAt: null } }, enrollments: { where: { status: "ACTIVE" } } } } } }),
    prisma.course.count({ where }),
    prisma.course.count({ where: { academyId, deletedAt: null } }),
    prisma.course.count({ where: { academyId, deletedAt: null, status: "ACTIVE" } }),
    prisma.academyCourseEnrollment.groupBy({ by: ["studentId"], where: { academyId, status: "ACTIVE", course: { deletedAt: null } } }),
    prisma.contentItem.count({ where: { deletedAt: null, course: { academyId, deletedAt: null } } }),
  ]);
  return {
    ...pageResult(courses, total, page, limit),
    summary: { totalCourses, activeCourses, totalEnrolledStudents: uniqueEnrolledStudents.length, totalContentItems },
  };
}

export async function getAcademyCourseDetail(context: TenantContext, courseId: string) {
  const academyId = requiredAcademyId(context);
  const course = await prisma.course.findFirst({
    where: { id: courseId, academyId },
    include: {
      _count: { select: { contentItems: { where: { deletedAt: null } }, questions: { where: { deletedAt: null } }, enrollments: { where: { status: "ACTIVE" } } } },
      contentItems: { where: { deletedAt: null }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 20, select: { id: true, name: true, kind: true, status: true, updatedAt: true } },
      questions: { where: { deletedAt: null }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 20, select: { id: true, kind: true, status: true, difficulty: true, questionHtml: true } },
      enrollments: { where: { status: "ACTIVE", academyId }, orderBy: [{ enrolledAt: "desc" }, { id: "desc" }], take: 20, select: { id: true, status: true, enrolledAt: true, student: { select: { id: true, fullName: true, email: true, status: true } } } },
    },
  });
  if (!course) throw notFound("COURSE_NOT_FOUND", "The course was not found in this academy.");
  return course;
}

export async function createAcademyCourse(context: TenantContext, payload: { name: string; code: string; description?: string; status?: "ACTIVE" | "INACTIVE" | "ARCHIVED" }) {
  const academyId = requiredAcademyId(context);
  try {
    return await prisma.$transaction(async (transaction) => {
      const status = payload.status ?? "ACTIVE";
      const course = await transaction.course.create({ data: {
        academyId, name: payload.name.trim(), code: payload.code.trim().toUpperCase(),
        slug: `${payload.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)}-${randomUUID().slice(0, 8)}`,
        description: payload.description?.trim() ?? "", status,
        deletedAt: status === "ARCHIVED" ? new Date() : null,
      } });
      await writeAudit(transaction, { action: "COURSE_CREATED", entityType: "Course", entityId: course.id, academyId, actorId: context.user.id, description: `Created course ${course.code}.` });
      return course;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const target = Array.isArray(error.meta?.target) ? error.meta.target.join(",") : String(error.meta?.target ?? "");
      if (target.includes("academyId") && target.includes("code")) {
        throw conflict("COURSE_CODE_CONFLICT", "A course with this code already exists.");
      }
      if (target.includes("name")) {
        throw conflict("COURSE_NAME_CONFLICT", "A course with this name already exists in this academy.");
      }
    }
    throw error;
  }
}

export async function updateAcademyCourse(context: TenantContext, courseId: string, payload: { name?: string; code?: string; description?: string; status?: "ACTIVE" | "INACTIVE" | "ARCHIVED" }) {
  const academyId = requiredAcademyId(context);
  const data: Prisma.CourseUpdateInput = {};
  if (payload.name !== undefined) data.name = payload.name.trim();
  if (payload.code !== undefined) data.code = payload.code.trim().toUpperCase();
  if (payload.description !== undefined) data.description = payload.description.trim();
  if (payload.status !== undefined) {
    data.status = payload.status;
    data.deletedAt = payload.status === "ARCHIVED" ? new Date() : null;
  }
  try {
    return await prisma.$transaction(async (transaction) => {
      const existing = await transaction.course.findFirst({ where: { id: courseId, academyId } });
      if (!existing) throw notFound("COURSE_NOT_FOUND", "The course was not found in this academy.");
      const updated = await transaction.course.update({ where: { id: courseId }, data });
      await writeAudit(transaction, { action: "COURSE_UPDATED", entityType: "Course", entityId: courseId, academyId, actorId: context.user.id, description: `Updated course ${updated.code}.`, before: { name: existing.name, code: existing.code, description: existing.description, status: existing.status }, after: { name: updated.name, code: updated.code, description: updated.description, status: updated.status } });
      return updated;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const target = Array.isArray(error.meta?.target) ? error.meta.target.join(",") : String(error.meta?.target ?? "");
      if (target.includes("academyId") && target.includes("code")) {
        throw conflict("COURSE_CODE_CONFLICT", "A course with this code already exists.");
      }
      if (target.includes("name")) {
        throw conflict("COURSE_NAME_CONFLICT", "A course with this name already exists in this academy.");
      }
    }
    throw error;
  }
}

export async function archiveAcademyCourse(context: TenantContext, courseId: string) {
  return setCourseArchived(context, courseId, true);
}
export async function restoreAcademyCourse(context: TenantContext, courseId: string) {
  return setCourseArchived(context, courseId, false);
}
async function setCourseArchived(context: TenantContext, courseId: string, archived: boolean) {
  const academyId = requiredAcademyId(context);
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.course.findFirst({ where: { id: courseId, academyId, ...(archived ? { deletedAt: null } : { deletedAt: { not: null } }) } });
    if (!existing) throw notFound("COURSE_NOT_FOUND", "The course was not found in the requested lifecycle state.");
    const updated = await transaction.course.update({ where: { id: courseId }, data: archived ? { status: "ARCHIVED", deletedAt: new Date() } : { status: "INACTIVE", deletedAt: null } });
    await writeAudit(transaction, { action: archived ? "COURSE_ARCHIVED" : "COURSE_RESTORED", entityType: "Course", entityId: courseId, academyId, actorId: context.user.id, description: `${archived ? "Archived" : "Restored"} course ${existing.code}.` });
    return updated;
  });
}

export async function getAcademyQuestions(context: TenantContext, input: PageInput = {}) {
  const academyId = requiredAcademyId(context); const { page, limit } = paging(input);
  const where = { academyId, deletedAt: null } satisfies Prisma.QuestionWhereInput;
  const [data, total] = await Promise.all([
    prisma.question.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: { course: { select: { id: true, name: true } }, options: true } }),
    prisma.question.count({ where }),
  ]);
  return pageResult(data, total, page, limit);
}

export async function createAcademyQuestion(context: TenantContext, payload: { kind: "NORMAL_MCQ" | "NORMAL_DESCRIPTIVE" | "CASE_MCQ" | "CASE_DESCRIPTIVE"; courseId?: string; questionHtml: string; answerHtml?: string; difficulty?: "FOUNDATION" | "INTERMEDIATE" | "ADVANCED"; status?: "DRAFT" | "PUBLISHED"; correctOptionId?: string; options?: Array<{ optionLabel: string; html: string }> }) {
  const academyId = requiredAcademyId(context);
  return prisma.$transaction(async (transaction) => {
    if (payload.courseId && !await transaction.course.findFirst({ where: { id: payload.courseId, academyId, deletedAt: null }, select: { id: true } })) throw notFound("COURSE_NOT_FOUND", "The target course was not found in this academy.");
    const questionHtml = sanitizeRichText(payload.questionHtml);
    const answerHtml = sanitizeRichText(payload.answerHtml ?? "");
    if (!questionHtml) throw badRequest("QUESTION_TEXT_REQUIRED", "Question content is required.");
    const isMcq = payload.kind === "NORMAL_MCQ" || payload.kind === "CASE_MCQ";
    const options = payload.options?.map((option, index) => ({ optionLabel: option.optionLabel.toUpperCase(), html: sanitizeRichText(option.html), displayOrder: index })) ?? [];
    if (isMcq && (options.length < 2 || !payload.correctOptionId || !options.some((option) => option.optionLabel === payload.correctOptionId?.toUpperCase()))) throw badRequest("INVALID_MCQ_OPTIONS", "MCQ questions require at least two options and a matching correctOptionId.");
    if (!isMcq && options.length) throw badRequest("OPTIONS_NOT_ALLOWED", "Descriptive questions cannot contain MCQ options.");
    const question = await transaction.question.create({ data: { academyId, courseId: payload.courseId, kind: payload.kind, status: payload.status ?? "DRAFT", difficulty: payload.difficulty ?? "INTERMEDIATE", questionHtml, answerHtml, correctOptionId: isMcq ? payload.correctOptionId?.toUpperCase() : null, options: options.length ? { create: options } : undefined }, include: { options: true } });
    await writeAudit(transaction, { action: "QUESTION_CREATED", entityType: "Question", entityId: question.id, academyId, actorId: context.user.id, description: "Created an academy question." });
    return question;
  });
}

export async function getAcademyBroadcasts(context: TenantContext, input: PageInput & { search?: string; status?: "DRAFT" | "SCHEDULED" | "ACTIVE" | "EXPIRED" | "ARCHIVED" | "DISABLED"; type?: "ANNOUNCEMENT" | "IMPORTANT_NOTICE" | "UPDATE" | "MAINTENANCE" | "FEATURE_UPDATE" | "ACADEMIC" | "GENERAL" | "CRITICAL_ALERT" } = {}) {
  const academyId = requiredAcademyId(context); const { page, limit } = paging(input);
  const where = {
    academyId,
    deletedAt: null,
    ...(input.status ? { status: input.status } : {}),
    ...(input.type ? { type: input.type } : {}),
    ...(input.search ? { OR: [{ title: { contains: input.search, mode: "insensitive" as const } }, { subtitle: { contains: input.search, mode: "insensitive" as const } }, { message: { contains: input.search, mode: "insensitive" as const } }] } : {}),
  } satisfies Prisma.BroadcastWhereInput;
  const [data, total] = await Promise.all([
    prisma.broadcast.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: academyBroadcastInclude }),
    prisma.broadcast.count({ where }),
  ]);
  return pageResult(data, total, page, limit);
}

type AcademyBroadcastInput = {
  title: string; subtitle?: string; message: string; type?: "ANNOUNCEMENT" | "IMPORTANT_NOTICE" | "UPDATE" | "MAINTENANCE" | "FEATURE_UPDATE" | "ACADEMIC" | "GENERAL" | "CRITICAL_ALERT";
  priority?: "LOW" | "NORMAL" | "HIGH" | "CRITICAL"; targetCourseId?: string | null; startAt?: string; endAt?: string;
  platform?: "APP" | "WEBSITE" | "BOTH"; placements?: Array<"NOTIFICATION" | "HOME" | "COURSE" | "GENERAL">;
  cta?: { enabled: boolean; text: string; action: "INTERNAL_ROUTE" | "EXTERNAL_URL" | "COURSE" | "CONTENT"; destination: string };
  frequency?: "ONCE" | "DAILY" | "EVERY_VISIT" | "UNTIL_DISMISSED" | "ALWAYS_ACTIVE"; dismissible?: boolean;
  presentation?: "BANNER" | "NOTIFICATION" | "CARD" | "MODAL" | "WHATS_NEW" | "CRITICAL_ALERT";
  displayOrder?: "AUTOMATIC" | "PINNED" | "CUSTOM"; customOrderWeight?: number; acknowledgementRequired?: boolean;
  repeatBehavior?: "NEVER" | "INTERVAL" | "CONTINUE"; showInWhatsNew?: boolean;
};
type AcademyBroadcastUpdateInput = Partial<Omit<AcademyBroadcastInput, "startAt" | "endAt">> & { startAt?: string | null; endAt?: string | null };

const academyBroadcastInclude = {
  placements: true,
  cta: true,
  image: true,
  courseTargets: { select: { course: { select: { id: true, name: true } } } },
  timeline: { orderBy: { timestamp: "desc" as const }, take: 100 },
} satisfies Prisma.BroadcastInclude;

async function requireAcademyBroadcastCourse(transaction: Prisma.TransactionClient, academyId: string, courseId: string) {
  const course = await transaction.course.findFirst({ where: { id: courseId, academyId, deletedAt: null }, select: { id: true, name: true } });
  if (!course) throw notFound("COURSE_NOT_FOUND", "The broadcast target course was not found in this academy.");
  return course;
}

async function validateAcademyBroadcastCta(transaction: Prisma.TransactionClient, academyId: string, cta?: AcademyBroadcastInput["cta"]) {
  if (!cta?.enabled) return;
  if (!cta.text || !cta.destination) throw badRequest("INVALID_BROADCAST_CTA", "CTA text and destination are required when the CTA is enabled.");
  if (cta.action === "INTERNAL_ROUTE") {
    const normalized = cta.destination.trim().toLocaleLowerCase();
    const forbiddenPrefixes = ["/admin", "/store", "/packages", "/academies"];
    if (!normalized.startsWith("/") || normalized.startsWith("//") || forbiddenPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
      throw badRequest("INVALID_BROADCAST_CTA", "Academy broadcast links must use an Academy-safe internal route.");
    }
  }
  if (cta.action === "EXTERNAL_URL") {
    try { const url = new URL(cta.destination); if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error(); }
    catch { throw badRequest("INVALID_BROADCAST_CTA", "The external CTA destination must be an http or https URL."); }
  }
  if (cta.action === "COURSE") await requireAcademyBroadcastCourse(transaction, academyId, cta.destination);
  if (cta.action === "CONTENT") {
    const item = await transaction.contentItem.findFirst({ where: { id: cta.destination, deletedAt: null, course: { academyId, deletedAt: null } }, select: { id: true } });
    if (!item) throw notFound("CONTENT_NOT_FOUND", "The CTA content destination was not found in this academy.");
  }
}

export async function createAcademyBroadcast(context: TenantContext, payload: AcademyBroadcastInput) {
  const academyId = requiredAcademyId(context);
  const startAt = payload.startAt ? new Date(payload.startAt) : null;
  const endAt = payload.endAt ? new Date(payload.endAt) : null;
  if (startAt && endAt && endAt <= startAt) throw badRequest("INVALID_BROADCAST_RANGE", "endAt must be later than startAt.");
  return prisma.$transaction(async (transaction) => {
    const targetCourse = payload.targetCourseId ? await requireAcademyBroadcastCourse(transaction, academyId, payload.targetCourseId) : null;
    await validateAcademyBroadcastCta(transaction, academyId, payload.cta);
    const placements: Array<"NOTIFICATION" | "HOME" | "COURSE" | "GENERAL"> = payload.placements ?? ["NOTIFICATION"];
    const broadcast = await transaction.broadcast.create({ data: {
      academyId, title: payload.title.trim(), subtitle: payload.subtitle?.trim() ?? "", message: payload.message.trim(), type: payload.type ?? "ANNOUNCEMENT", priority: payload.priority ?? "NORMAL", status: "DRAFT", startAt, endAt,
      platform: "APP", audienceKind: targetCourse ? "COURSES" : "ACADEMY_STUDENTS", frequency: payload.frequency ?? "ONCE", dismissible: payload.dismissible ?? true,
      presentation: payload.presentation ?? "NOTIFICATION", displayOrder: payload.displayOrder ?? "AUTOMATIC", customOrderWeight: payload.customOrderWeight ?? 50,
      acknowledgementRequired: payload.acknowledgementRequired ?? false, repeatBehavior: payload.repeatBehavior ?? "NEVER", showInWhatsNew: payload.showInWhatsNew ?? false,
      placements: { create: [...new Set(placements)].map((placement) => ({ placement })) },
      cta: payload.cta?.enabled ? { create: { enabled: true, text: payload.cta.text, action: payload.cta.action, destination: payload.cta.destination } } : undefined,
      courseTargets: targetCourse ? { create: { courseId: targetCourse.id } } : undefined,
      timeline: { create: { actorId: context.user.id, action: "CREATED", description: "Created academy broadcast." } },
    }, include: academyBroadcastInclude });
    await writeAudit(transaction, { action: "BROADCAST_CREATED", entityType: "Broadcast", entityId: broadcast.id, academyId, actorId: context.user.id, description: `Created broadcast ${broadcast.title}.`, metadata: { targetCourseId: targetCourse?.id ?? null } });
    return broadcast;
  });
}

export async function getAcademyBroadcastDetail(context: TenantContext, broadcastId: string) {
  const academyId = requiredAcademyId(context);
  const broadcast = await prisma.broadcast.findFirst({ where: { id: broadcastId, academyId, deletedAt: null }, include: academyBroadcastInclude });
  if (!broadcast) throw notFound("BROADCAST_NOT_FOUND", "The broadcast was not found in this academy.");
  return broadcast;
}

export async function updateAcademyBroadcast(context: TenantContext, broadcastId: string, payload: AcademyBroadcastUpdateInput) {
  const academyId = requiredAcademyId(context);
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.broadcast.findFirst({ where: { id: broadcastId, academyId, deletedAt: null } });
    if (!existing) throw notFound("BROADCAST_NOT_FOUND", "The broadcast was not found in this academy.");
    if (!["DRAFT", "SCHEDULED"].includes(existing.status)) throw conflict("BROADCAST_IMMUTABLE", "Only draft or scheduled broadcasts can be edited.");
    const data: Prisma.BroadcastUpdateInput = {};
    if (payload.title !== undefined) data.title = payload.title.trim();
    if (payload.subtitle !== undefined) data.subtitle = payload.subtitle.trim();
    if (payload.message !== undefined) data.message = payload.message.trim();
    if (payload.type !== undefined) data.type = payload.type;
    if (payload.priority !== undefined) data.priority = payload.priority;
    data.platform = "APP";
    if (payload.frequency !== undefined) data.frequency = payload.frequency;
    if (payload.dismissible !== undefined) data.dismissible = payload.dismissible;
    if (payload.presentation !== undefined) data.presentation = payload.presentation;
    if (payload.displayOrder !== undefined) data.displayOrder = payload.displayOrder;
    if (payload.customOrderWeight !== undefined) data.customOrderWeight = payload.customOrderWeight;
    if (payload.acknowledgementRequired !== undefined) data.acknowledgementRequired = payload.acknowledgementRequired;
    if (payload.repeatBehavior !== undefined) data.repeatBehavior = payload.repeatBehavior;
    if (payload.showInWhatsNew !== undefined) data.showInWhatsNew = payload.showInWhatsNew;
    if (payload.placements !== undefined) data.placements = { deleteMany: {}, create: [...new Set(payload.placements)].map((placement) => ({ placement })) };
    if (payload.cta !== undefined) {
      await validateAcademyBroadcastCta(transaction, academyId, payload.cta);
      if (payload.cta.enabled) data.cta = { upsert: { create: { enabled: true, text: payload.cta.text, action: payload.cta.action, destination: payload.cta.destination }, update: { enabled: true, text: payload.cta.text, action: payload.cta.action, destination: payload.cta.destination } } };
      else await transaction.broadcastCta.deleteMany({ where: { broadcastId } });
    }
    if (payload.targetCourseId !== undefined) {
      const targetCourse = payload.targetCourseId ? await requireAcademyBroadcastCourse(transaction, academyId, payload.targetCourseId) : null;
      data.audienceKind = targetCourse ? "COURSES" : "ACADEMY_STUDENTS";
      data.courseTargets = { deleteMany: {}, ...(targetCourse ? { create: { courseId: targetCourse.id } } : {}) };
    }
    if (payload.startAt !== undefined) data.startAt = payload.startAt ? new Date(payload.startAt) : null;
    if (payload.endAt !== undefined) data.endAt = payload.endAt ? new Date(payload.endAt) : null;
    const nextStart = data.startAt instanceof Date ? data.startAt : existing.startAt;
    const nextEnd = data.endAt instanceof Date ? data.endAt : payload.endAt === null ? null : existing.endAt;
    if (nextStart && nextEnd && nextEnd <= nextStart) throw badRequest("INVALID_BROADCAST_RANGE", "endAt must be later than startAt.");
    data.timeline = { create: { actorId: context.user.id, action: "UPDATED", description: "Updated academy broadcast." } };
    const updated = await transaction.broadcast.update({ where: { id: broadcastId }, data, include: academyBroadcastInclude });
    await writeAudit(transaction, { action: "BROADCAST_UPDATED", entityType: "Broadcast", entityId: broadcastId, academyId, actorId: context.user.id, description: `Updated broadcast ${updated.title}.`, metadata: payload.targetCourseId !== undefined ? { targetCourseId: payload.targetCourseId } : undefined });
    return updated;
  });
}

export async function publishAcademyBroadcast(context: TenantContext, broadcastId: string) {
  const academyId = requiredAcademyId(context);
  const published = await prisma.$transaction(async (transaction) => {
    const existing = await transaction.broadcast.findFirst({ where: { id: broadcastId, academyId, deletedAt: null, status: { in: ["DRAFT", "SCHEDULED"] } }, include: { courseTargets: { select: { courseId: true } } } });
    if (!existing) throw conflict("BROADCAST_NOT_PUBLISHABLE", "The broadcast is not available for publishing.");
    const targetCourseId = existing.audienceKind === "COURSES" ? existing.courseTargets[0]?.courseId : null;
    if (existing.audienceKind === "COURSES") {
      if (!targetCourseId || existing.courseTargets.length !== 1) throw conflict("BROADCAST_AUDIENCE_INVALID", "The course broadcast has no valid target course.");
      await requireAcademyBroadcastCourse(transaction, academyId, targetCourseId);
    }
    const now = new Date();
    const updated = await transaction.broadcast.update({ where: { id: broadcastId }, data: { status: "ACTIVE", publishedAt: now, startAt: existing.startAt ?? now, timeline: { create: { actorId: context.user.id, action: "PUBLISHED", description: "Published academy broadcast." } } } });
    const notification = await transaction.notification.create({ data: { academyId, senderId: context.user.id, title: updated.title, body: updated.message, type: updated.type === "ACADEMIC" ? "ACADEMIC_UPDATE" : updated.priority === "CRITICAL" ? "ALERT" : "ANNOUNCEMENT", priority: updated.priority === "CRITICAL" ? "URGENT" : updated.priority === "HIGH" ? "HIGH" : "NORMAL", targetType: targetCourseId ? "COURSE" : "ALL_STUDENTS", targetCourseId, status: "DRAFT" } });
    const job = await enqueueJob({ kind: "NOTIFICATION_SEND", payload: { notificationId: notification.id, academyId, actorId: context.user.id }, academyId, createdById: context.user.id, deduplicationKey: notification.id }, transaction);
    await writeAudit(transaction, { action: "BROADCAST_PUBLISHED", entityType: "Broadcast", entityId: broadcastId, academyId, actorId: context.user.id, description: `Published broadcast ${updated.title}.` });
    return { updated, notificationId: notification.id, jobId: job.id };
  });
  try {
    const delivered = await dispatchQueuedNotification(published.notificationId, academyId, context.user.id);
    return { ...published.updated, delivery: { notificationId: published.notificationId, jobId: published.jobId, status: "SENT" as const, totalRecipients: delivered.totalRecipients } };
  } catch {
    // The durable background job remains queued and will retry transient delivery failures.
    return { ...published.updated, delivery: { notificationId: published.notificationId, jobId: published.jobId, status: "QUEUED" as const } };
  }
}

export async function scheduleAcademyBroadcast(context: TenantContext, broadcastId: string, startAt: string) {
  const academyId = requiredAcademyId(context);
  const scheduledAt = new Date(startAt);
  if (scheduledAt <= new Date()) throw badRequest("INVALID_BROADCAST_SCHEDULE", "startAt must be in the future.");
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.broadcast.findFirst({ where: { id: broadcastId, academyId, deletedAt: null, status: { in: ["DRAFT", "SCHEDULED"] } } });
    if (!existing) throw conflict("BROADCAST_NOT_SCHEDULABLE", "Only draft or scheduled broadcasts can be scheduled.");
    const updated = await transaction.broadcast.update({ where: { id: broadcastId }, data: { status: "SCHEDULED", startAt: scheduledAt, timeline: { create: { actorId: context.user.id, action: "SCHEDULED", description: "Scheduled academy broadcast." } } } });
    await enqueueJob({ kind: "BROADCAST_PUBLISH", payload: { broadcastId, academyId, actorId: context.user.id }, academyId, createdById: context.user.id, runAt: scheduledAt, deduplicationKey: broadcastId }, transaction);
    await writeAudit(transaction, { action: "BROADCAST_SCHEDULED", entityType: "Broadcast", entityId: broadcastId, academyId, actorId: context.user.id, description: `Scheduled broadcast ${updated.title}.` });
    return updated;
  });
}

export async function cancelAcademyBroadcast(context: TenantContext, broadcastId: string) {
  const academyId = requiredAcademyId(context);
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.broadcast.findFirst({ where: { id: broadcastId, academyId, deletedAt: null, status: "SCHEDULED" } });
    if (!existing) throw conflict("BROADCAST_NOT_CANCELLABLE", "Only scheduled broadcasts can be cancelled.");
    const updated = await transaction.broadcast.update({ where: { id: broadcastId }, data: { status: "DRAFT", startAt: null, timeline: { create: { actorId: context.user.id, action: "SCHEDULE_CHANGED", description: "Cancelled academy broadcast schedule." } } } });
    await transaction.backgroundJob.updateMany({ where: { kind: "BROADCAST_PUBLISH", deduplicationKey: broadcastId, status: { in: ["PENDING", "PROCESSING"] } }, data: { status: "CANCELLED", lockedAt: null, lockedBy: null } });
    await writeAudit(transaction, { action: "BROADCAST_SCHEDULE_CHANGED", entityType: "Broadcast", entityId: broadcastId, academyId, actorId: context.user.id, description: `Cancelled schedule for broadcast ${updated.title}.` });
    return updated;
  });
}

export async function deleteAcademyBroadcast(context: TenantContext, broadcastId: string) {
  const academyId = requiredAcademyId(context);
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.broadcast.findFirst({ where: { id: broadcastId, academyId, deletedAt: null, status: { in: ["DRAFT", "ARCHIVED", "DISABLED"] } } });
    if (!existing) throw conflict("BROADCAST_NOT_DELETABLE", "Only draft, archived, or disabled broadcasts can be deleted.");
    const updated = await transaction.broadcast.update({ where: { id: broadcastId }, data: { deletedAt: new Date(), status: "ARCHIVED", timeline: { create: { actorId: context.user.id, action: "DELETED", description: "Soft-deleted academy broadcast." } } } });
    await writeAudit(transaction, { action: "BROADCAST_DELETED", entityType: "Broadcast", entityId: broadcastId, academyId, actorId: context.user.id, description: `Soft-deleted broadcast ${updated.title}.` });
    return { id: updated.id, deletedAt: updated.deletedAt };
  });
}

export async function publishScheduledBroadcast(broadcastId: string, academyId: string, actorId: string) {
  const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { id: true, email: true, fullName: true, role: { select: { key: true } } } });
  if (!actor) throw notFound("BROADCAST_ACTOR_NOT_FOUND", "The scheduling actor no longer exists.");
  const context: TenantContext = { user: { id: actor.id, email: actor.email, fullName: actor.fullName, roleKey: actor.role.key }, academyId, roleInAcademy: "ACADEMY_ADMIN", membershipId: null, permissions: new Set(["academy:manage"]), isSuperAdmin: actor.role.key === "super_admin" };
  return publishAcademyBroadcast(context, broadcastId);
}

export async function archiveAcademyBroadcast(context: TenantContext, broadcastId: string) {
  const academyId = requiredAcademyId(context);
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.broadcast.findFirst({ where: { id: broadcastId, academyId, deletedAt: null } });
    if (!existing) throw notFound("BROADCAST_NOT_FOUND", "The broadcast was not found in this academy.");
    const updated = await transaction.broadcast.update({ where: { id: broadcastId }, data: { status: "ARCHIVED", timeline: { create: { actorId: context.user.id, action: "ARCHIVED", description: "Archived academy broadcast." } } } });
    await writeAudit(transaction, { action: "BROADCAST_ARCHIVED", entityType: "Broadcast", entityId: broadcastId, academyId, actorId: context.user.id, description: `Archived broadcast ${updated.title}.` });
    return updated;
  });
}

export async function restoreAcademyBroadcast(context: TenantContext, broadcastId: string) {
  const academyId = requiredAcademyId(context);
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.broadcast.findFirst({ where: { id: broadcastId, academyId, deletedAt: null, status: { in: ["ARCHIVED", "DISABLED", "EXPIRED"] } } });
    if (!existing) throw conflict("BROADCAST_NOT_RESTORABLE", "The broadcast is not in a restorable state.");
    const updated = await transaction.broadcast.update({ where: { id: broadcastId }, data: { status: "DRAFT", disabledFrom: null, publishedAt: null, timeline: { create: { actorId: context.user.id, action: "RESTORED", description: "Restored academy broadcast as draft." } } } });
    await writeAudit(transaction, { action: "BROADCAST_RESTORED", entityType: "Broadcast", entityId: broadcastId, academyId, actorId: context.user.id, description: `Restored broadcast ${updated.title} as a draft.` });
    return updated;
  });
}
