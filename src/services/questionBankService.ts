import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { badRequest, conflict, notFound } from "../errors/api-error.js";
import type { QuestionScope } from "./questionService.js";
import { normalizeAccessDurationPolicy } from "./resourceValidityService.js";

export type QuestionBankInput = {
  courseId: string;
  name: string;
  description?: string;
  accessType: "FREE" | "PAID";
  price?: number | null;
  accessDurationValue?: number | null;
  accessDurationUnit?: "DAYS" | "WEEKS" | "MONTHS" | null;
};

const scopeWhere = (scope: QuestionScope): Prisma.QuestionBankWhereInput =>
  scope.academyId ? { academyId: scope.academyId } : { academyId: null };

const slugify = (value: string) => value
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 96) || "question-bank";

async function assertCourseAndPolicy(
  tx: Prisma.TransactionClient,
  scope: QuestionScope,
  input: QuestionBankInput,
) {
  const course = await tx.course.findFirst({
    where: { id: input.courseId, deletedAt: null, ...(scope.academyId ? { academyId: scope.academyId } : { academyId: null }) },
    select: { id: true },
  });
  if (!course) throw notFound("COURSE_NOT_FOUND", "The selected course was not found in the current tenant.");
  if (input.accessType === "PAID" && (!Number.isFinite(input.price) || Number(input.price) <= 0)) {
    throw badRequest("PAID_QUESTION_BANK_PRICE_REQUIRED", "A paid Question Bank must have a positive price.");
  }
  return normalizeAccessDurationPolicy({
    accessType: input.accessType,
    accessDurationValue: input.accessDurationValue,
    accessDurationUnit: input.accessDurationUnit,
  });
}

async function audit(tx: Prisma.TransactionClient, scope: QuestionScope, action: string, bankId: string, description: string) {
  await tx.systemAuditLog.create({
    data: { action, entityType: "QuestionBank", entityId: bankId, actorId: scope.actorId, academyId: scope.academyId, description },
  });
}

const bankInclude = {
  course: { select: { id: true, name: true } },
  _count: {
    select: {
      questions: { where: { status: "PUBLISHED", deletedAt: null } },
      practiceSessions: true,
    },
  },
} satisfies Prisma.QuestionBankInclude;

export async function listQuestionBanks(scope: QuestionScope, input: { courseId: string; includeArchived?: boolean }) {
  const course = await prisma.course.findFirst({
    where: { id: input.courseId, deletedAt: null, ...(scope.academyId ? { academyId: scope.academyId } : { academyId: null }) },
    select: { id: true },
  });
  if (!course) throw notFound("COURSE_NOT_FOUND", "The selected course was not found in the current tenant.");
  return prisma.questionBank.findMany({
    where: { ...scopeWhere(scope), courseId: input.courseId, ...(input.includeArchived ? {} : { deletedAt: null, status: { not: "ARCHIVED" } }) },
    include: bankInclude,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
}

export async function getQuestionBank(scope: QuestionScope, bankId: string) {
  const bank = await prisma.questionBank.findFirst({
    where: { id: bankId, ...scopeWhere(scope) },
    include: {
      ...bankInclude,
      questions: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: { options: { orderBy: { displayOrder: "asc" } }, contentLinks: { include: { contentItem: { select: { id: true, name: true, accessType: true, mimeType: true } } } } },
      },
    },
  });
  if (!bank) throw notFound("QUESTION_BANK_NOT_FOUND", "The Question Bank was not found in the current tenant.");
  return bank;
}

export async function createQuestionBank(scope: QuestionScope, input: QuestionBankInput) {
  return prisma.$transaction(async (tx) => {
    const policy = await assertCourseAndPolicy(tx, scope, input);
    const base = slugify(input.name);
    const collision = await tx.questionBank.findFirst({ where: { courseId: input.courseId, slug: base }, select: { id: true } });
    const slug = collision ? `${base}-${Date.now().toString(36)}` : base;
    const bank = await tx.questionBank.create({
      data: {
        academyId: scope.academyId,
        courseId: input.courseId,
        packageId: null,
        name: input.name.trim(),
        slug,
        description: input.description?.trim() ?? "",
        accessType: input.accessType,
        price: input.accessType === "PAID" ? input.price! : 0,
        accessDurationValue: policy.accessDurationValue,
        accessDurationUnit: policy.accessDurationUnit,
        createdById: scope.actorId,
      },
      include: bankInclude,
    });
    await audit(tx, scope, "QUESTION_BANK_CREATED", bank.id, `Created Question Bank ${bank.name}.`);
    return bank;
  });
}

export async function updateQuestionBank(scope: QuestionScope, bankId: string, input: QuestionBankInput) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.questionBank.findFirst({ where: { id: bankId, deletedAt: null, ...scopeWhere(scope) } });
    if (!existing) throw notFound("QUESTION_BANK_NOT_FOUND", "The Question Bank was not found in the current tenant.");
    const policy = await assertCourseAndPolicy(tx, scope, input);
    if (existing.status === "PUBLISHED" && existing.courseId !== input.courseId) {
      throw conflict("PUBLISHED_QUESTION_BANK_COURSE_LOCKED", "Archive the Question Bank before changing its course.");
    }
    const bank = await tx.questionBank.update({
      where: { id: bankId },
      data: { courseId: input.courseId, packageId: null, name: input.name.trim(), description: input.description?.trim() ?? "", accessType: input.accessType, price: input.accessType === "PAID" ? input.price! : 0, accessDurationValue: policy.accessDurationValue, accessDurationUnit: policy.accessDurationUnit },
      include: bankInclude,
    });
    await audit(tx, scope, "QUESTION_BANK_UPDATED", bank.id, `Updated Question Bank ${bank.name}.`);
    return bank;
  });
}

export async function setQuestionBankLifecycle(scope: QuestionScope, bankId: string, action: "publish" | "archive" | "restore") {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.questionBank.findFirst({
      where: { id: bankId, ...scopeWhere(scope) },
      include: { _count: { select: { questions: true } } },
    });
    if (!existing) throw notFound("QUESTION_BANK_NOT_FOUND", "The Question Bank was not found in the current tenant.");
    if (action === "publish") {
      const publishedQuestionCount = await tx.question.count({
        where: { questionBankId: existing.id, status: "PUBLISHED", deletedAt: null },
      });
      if (!publishedQuestionCount) {
        throw conflict("QUESTION_BANK_EMPTY", "Publish at least one question inside this Question Bank before publishing the bank.");
      }
      if (existing.accessType === "PAID" && existing.price.lte(0)) {
        throw conflict("QUESTION_BANK_STORE_PRODUCT_NOT_READY", "Set a positive Question Bank price before publishing it.");
      }
    }
    const data = action === "archive"
      ? { status: "ARCHIVED" as const, deletedAt: new Date() }
      : action === "restore"
        ? { status: "DRAFT" as const, deletedAt: null }
        : { status: "PUBLISHED" as const, deletedAt: null };
    const bank = await tx.questionBank.update({ where: { id: bankId }, data, include: bankInclude });
    const auditAction = action === "publish" ? "QUESTION_BANK_PUBLISHED" : action === "archive" ? "QUESTION_BANK_ARCHIVED" : "QUESTION_BANK_RESTORED";
    await audit(tx, scope, auditAction, bank.id, `${action} Question Bank ${bank.name}.`);
    return bank;
  });
}

export async function deleteQuestionBank(scope: QuestionScope, bankId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.questionBank.findFirst({
      where: { id: bankId, ...scopeWhere(scope) },
      include: { _count: { select: { questions: true, practiceSessions: true } } },
    });
    if (!existing) throw notFound("QUESTION_BANK_NOT_FOUND", "The Question Bank was not found in the current tenant.");
    if (existing.status !== "DRAFT") throw conflict("QUESTION_BANK_DELETE_REQUIRES_DRAFT", "Only a draft Question Bank can be permanently deleted.");
    if (existing._count.questions || existing._count.practiceSessions) {
      throw conflict("QUESTION_BANK_HAS_HISTORY", "This Question Bank has questions or practice history. Archive it instead so learner records remain intact.");
    }
    const commerceHistory = await tx.orderItem.count({ where: { questionBankId: existing.id } });
    if (commerceHistory) throw conflict("QUESTION_BANK_HAS_COMMERCE_HISTORY", "This Question Bank has purchase history. Archive it instead.");
    await audit(tx, scope, "QUESTION_BANK_DELETED", existing.id, `Permanently deleted empty draft Question Bank ${existing.name}.`);
    await tx.questionBank.delete({ where: { id: existing.id } });
    return { id: existing.id, deleted: true as const };
  });
}

export async function assertQuestionBankForWrite(
  tx: Prisma.TransactionClient,
  scope: QuestionScope,
  bankId: string,
  courseId: string,
) {
  const bank = await tx.questionBank.findFirst({
    where: { id: bankId, courseId, deletedAt: null, status: { not: "ARCHIVED" }, ...scopeWhere(scope) },
    select: { id: true, courseId: true },
  });
  if (!bank) throw badRequest("INVALID_QUESTION_BANK", "The selected Question Bank does not belong to this course and tenant.");
  return bank;
}
