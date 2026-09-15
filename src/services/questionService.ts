import { randomUUID } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { badRequest, conflict, notFound } from "../errors/api-error.js";
import { sanitizeRichText } from "../utils/sanitize-html.js";
import { accessibleContentIdsForCourse } from "./noteCatalogService.js";
import { assertQuestionBankForWrite } from "./questionBankService.js";

export interface QuestionScope { academyId?: string; actorId: string }
export interface OptionInput { optionLabel: string; html: string }
export interface SubQuestionInput { questionHtml: string; answerHtml?: string; correctOptionId?: string; correctExplanationHtml?: string; premiumWrongOptionsExplanationHtml?: string; courseId?: string; subjectId?: string; chapterId?: string; lessonId?: string; topicId?: string; examName?: string; chapterName?: string; conceptName?: string; options?: OptionInput[] }
export interface QuestionInput {
  kind: "NORMAL_MCQ" | "NORMAL_DESCRIPTIVE" | "CASE_MCQ" | "CASE_DESCRIPTIVE";
  status?: "DRAFT" | "PUBLISHED";
  difficulty?: "FOUNDATION" | "INTERMEDIATE" | "ADVANCED";
  questionHtml?: string; answerHtml?: string; caseHtml?: string; classificationMode?: "ENTIRE_CASE" | "INDIVIDUAL_SUB_QUESTIONS";
  correctOptionId?: string; correctExplanationHtml?: string; premiumWrongOptionsExplanationHtml?: string;
  courseId?: string; subjectId?: string; chapterId?: string; lessonId?: string; topicId?: string;
  examName?: string; chapterName?: string; conceptName?: string;
  contentItemIds?: string[];
  questionBankId?: string;
  practiceCollection?: "PYQ" | "RTP" | "MTP" | "ORIGINAL" | "QUESTION_BANK";
  options?: OptionInput[]; subQuestions?: SubQuestionInput[];
}

const scopeWhere = (scope: QuestionScope): Prisma.QuestionWhereInput => scope.academyId ? { academyId: scope.academyId } : { academyId: null };
const rich = (value?: string) => sanitizeRichText(value ?? "");
const normalizeOptions = (options: OptionInput[] = []) => {
  const normalized = options.map((option, index) => ({ optionLabel: option.optionLabel.toUpperCase(), html: rich(option.html), displayOrder: index }));
  if (normalized.length > 4 || new Set(normalized.map((option) => option.optionLabel)).size !== normalized.length || normalized.some((option) => !/^[A-D]$/.test(option.optionLabel) || !option.html)) throw badRequest("INVALID_OPTIONS", "Supply two to four unique, non-empty options labelled A through D.");
  return normalized;
};

async function validateTaxonomy(scope: QuestionScope, input: Pick<QuestionInput, "courseId" | "subjectId" | "chapterId" | "lessonId" | "topicId">, tx: Prisma.TransactionClient) {
  if (!input.courseId && (input.subjectId || input.chapterId || input.lessonId || input.topicId)) throw badRequest("COURSE_REQUIRED", "courseId is required when taxonomy fields are supplied.");
  if (!input.courseId) return;
  const course = await tx.course.findFirst({ where: { id: input.courseId, deletedAt: null, ...(scope.academyId ? { academyId: scope.academyId } : { academyId: null }) }, select: { id: true } });
  if (!course) throw notFound("COURSE_NOT_FOUND", "The taxonomy course was not found in the current scope.");
  if (input.subjectId && !await tx.subject.findFirst({ where: { id: input.subjectId, courseId: input.courseId, deletedAt: null }, select: { id: true } })) throw badRequest("INVALID_SUBJECT", "subjectId does not belong to the selected course.");
  if (input.chapterId && !await tx.taxonomyChapter.findFirst({ where: { id: input.chapterId, courseId: input.courseId, ...(input.subjectId ? { subjectId: input.subjectId } : {}) }, select: { id: true } })) throw badRequest("INVALID_CHAPTER", "chapterId does not belong to the selected taxonomy.");
  if (input.lessonId && !await tx.taxonomyLesson.findFirst({ where: { id: input.lessonId, ...(input.chapterId ? { chapterId: input.chapterId } : { chapter: { courseId: input.courseId } }) }, select: { id: true } })) throw badRequest("INVALID_LESSON", "lessonId does not belong to the selected taxonomy.");
  if (input.topicId && !await tx.taxonomyTopic.findFirst({ where: { id: input.topicId, ...(input.lessonId ? { lessonId: input.lessonId } : { lesson: { chapter: { courseId: input.courseId } } }) }, select: { id: true } })) throw badRequest("INVALID_TOPIC", "topicId does not belong to the selected taxonomy.");
}

async function validateLinkedFiles(scope: QuestionScope, courseId: string | undefined, contentItemIds: string[] | undefined, tx: Prisma.TransactionClient) {
  if (!courseId) throw badRequest("COURSE_REQUIRED", "A course is required for every question.");
  const ids = [...new Set(contentItemIds ?? [])];
  // Legacy/hidden descriptive records may remain unlinked. Every active MCQ
  // route requires at least one ID at validation time.
  if (!ids.length) return ids;
  const files = await tx.contentItem.findMany({
    where: {
      id: { in: ids }, courseId, kind: "FILE", deletedAt: null,
      course: { deletedAt: null, ...(scope.academyId ? { academyId: scope.academyId } : { academyId: null }) },
    },
    select: { id: true, courseId: true },
  });
  if (files.length !== ids.length) throw badRequest("INVALID_QUESTION_FILES", "Every linked item must be an existing file in the selected course and current tenant.");
  return ids;
}

export function validateQuestionShape(input: QuestionInput) {
  if (input.practiceCollection === "QUESTION_BANK" && !input.kind.endsWith("MCQ")) throw badRequest("QUESTION_BANK_MCQ_ONLY", "Question Banks support Normal MCQ and Case-based MCQ questions only.");
  if (input.practiceCollection === "QUESTION_BANK" && !input.questionBankId) throw badRequest("QUESTION_BANK_REQUIRED", "Select a Question Bank before adding Question Bank questions.");
  if (input.practiceCollection !== "QUESTION_BANK" && input.questionBankId) throw badRequest("QUESTION_BANK_NOT_ALLOWED", "questionBankId is only valid for Question Bank questions.");
  if (input.practiceCollection !== "QUESTION_BANK" && ["NORMAL_MCQ", "CASE_MCQ"].includes(input.kind) && !(input.contentItemIds?.length)) throw badRequest("QUESTION_FILES_REQUIRED", "Link at least one course file to an ordinary practice question.");
  const isCase = input.kind.startsWith("CASE_");
  const isMcq = input.kind.endsWith("MCQ");
  const options = normalizeOptions(input.options);
  if (!isCase && !rich(input.questionHtml)) throw badRequest("QUESTION_TEXT_REQUIRED", "Question content is required.");
  if (isCase && !rich(input.caseHtml)) throw badRequest("CASE_TEXT_REQUIRED", "Case content is required.");
  if (isMcq && !isCase && (options.length < 2 || !input.correctOptionId || !options.some((option) => option.optionLabel === input.correctOptionId!.toUpperCase()))) throw badRequest("INVALID_MCQ_OPTIONS", "MCQ questions require at least two options and a matching correctOptionId.");
  if (isCase && (options.length || input.correctOptionId)) throw badRequest("CASE_TOP_LEVEL_OPTIONS_NOT_ALLOWED", "Case questions define answers only on their sub-questions.");
  if (!isMcq && (options.length || input.correctOptionId)) throw badRequest("OPTIONS_NOT_ALLOWED", "Descriptive questions cannot contain top-level options or correctOptionId.");
  if (isCase && (!input.subQuestions || input.subQuestions.length < 1)) throw badRequest("SUB_QUESTIONS_REQUIRED", "Case questions require at least one sub-question.");
  for (const sub of input.subQuestions ?? []) {
    if (!rich(sub.questionHtml)) throw badRequest("SUB_QUESTION_TEXT_REQUIRED", "Every case sub-question requires question content.");
    const subOptions = normalizeOptions(sub.options);
    if (isMcq && (subOptions.length < 2 || !sub.correctOptionId || !subOptions.some((option) => option.optionLabel === sub.correctOptionId!.toUpperCase()))) {
      throw badRequest("INVALID_SUB_QUESTION_OPTIONS", "Every case MCQ sub-question requires at least two options and a matching correctOptionId.");
    }
    if (!isMcq && (subOptions.length || sub.correctOptionId)) throw badRequest("SUB_QUESTION_OPTIONS_NOT_ALLOWED", "Case descriptive sub-questions cannot contain options or correctOptionId.");
  }
  return options;
}

async function audit(tx: Prisma.TransactionClient, scope: QuestionScope, action: string, id: string, description: string) {
  await tx.systemAuditLog.create({ data: { action, entityType: "Question", entityId: id, actorId: scope.actorId, academyId: scope.academyId, description } });
}

const linkedFileInclude = { contentItem: { select: { id: true, name: true, mimeType: true, accessType: true, status: true, courseId: true } } };
const fullInclude = { options: { orderBy: { displayOrder: "asc" as const } }, subQuestions: { orderBy: { displayOrder: "asc" as const }, include: { options: { orderBy: { displayOrder: "asc" as const } } } }, contentLinks: { include: linkedFileInclude, orderBy: { createdAt: "asc" as const } }, questionBank: { select: { id: true, name: true, accessType: true, status: true } }, course: { select: { id: true, name: true } }, subject: { select: { id: true, name: true } }, chapter: true, lesson: true, topic: true };

export async function listQuestions(scope: QuestionScope, input: { page: number; limit: number; status?: "DRAFT" | "PUBLISHED" | "ARCHIVED"; kind?: QuestionInput["kind"]; practiceCollection?: QuestionInput["practiceCollection"]; difficulty?: QuestionInput["difficulty"]; courseId?: string; questionBankId?: string; contentItemId?: string; examName?: string; chapterName?: string; createdFrom?: Date; createdTo?: Date; updatedFrom?: Date; updatedTo?: Date; search?: string; includeDeleted?: boolean }) {
  if (!input.courseId) throw badRequest("COURSE_REQUIRED", "Select a course before loading questions.");
  const where: Prisma.QuestionWhereInput = { ...scopeWhere(scope), courseId: input.courseId, ...(input.includeDeleted ? {} : { deletedAt: null }), ...(input.status ? { status: input.status } : {}), ...(input.kind ? { kind: input.kind } : {}), ...(input.practiceCollection ? { practiceCollection: input.practiceCollection } : {}), ...(input.questionBankId ? { questionBankId: input.questionBankId } : {}), ...(input.difficulty ? { difficulty: input.difficulty } : {}), ...(input.examName ? { examName: { contains: input.examName, mode: "insensitive" } } : {}), ...(input.chapterName ? { chapterName: { contains: input.chapterName, mode: "insensitive" } } : {}), ...(input.contentItemId ? { contentLinks: { some: { contentItemId: input.contentItemId } } } : {}), ...((input.createdFrom || input.createdTo) ? { createdAt: { ...(input.createdFrom ? { gte: input.createdFrom } : {}), ...(input.createdTo ? { lte: input.createdTo } : {}) } } : {}), ...((input.updatedFrom || input.updatedTo) ? { updatedAt: { ...(input.updatedFrom ? { gte: input.updatedFrom } : {}), ...(input.updatedTo ? { lte: input.updatedTo } : {}) } } : {}), ...(input.search ? { OR: [{ questionHtml: { contains: input.search, mode: "insensitive" } }, { caseHtml: { contains: input.search, mode: "insensitive" } }, { contentLinks: { some: { contentItem: { name: { contains: input.search, mode: "insensitive" } } } } }] } : {}) };
  const [data, total] = await Promise.all([prisma.question.findMany({ where, skip: (input.page - 1) * input.limit, take: input.limit, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: { ...fullInclude, _count: { select: { options: true, subQuestions: true } } } }), prisma.question.count({ where })]);
  return { data, pagination: { page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit) } };
}

export async function getQuestion(scope: QuestionScope, questionId: string) {
  const question = await prisma.question.findFirst({ where: { id: questionId, ...scopeWhere(scope) }, include: fullInclude });
  if (!question) throw notFound("QUESTION_NOT_FOUND", "The question was not found in the current scope.");
  return question;
}

export async function listQuestionFiles(scope: QuestionScope, input: { courseId: string; search?: string }) {
  const course = await prisma.course.findFirst({
    where: { id: input.courseId, deletedAt: null, ...(scope.academyId ? { academyId: scope.academyId } : { academyId: null }) },
    select: { id: true },
  });
  if (!course) throw notFound("COURSE_NOT_FOUND", "The selected course was not found in the current tenant.");
  return prisma.contentItem.findMany({
    where: { courseId: input.courseId, kind: "FILE", deletedAt: null, ...(input.search ? { name: { contains: input.search, mode: "insensitive" } } : {}) },
    select: { id: true, name: true, mimeType: true, status: true, accessType: true, parentId: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 1000,
  });
}

function questionData(scope: QuestionScope, input: QuestionInput, options: ReturnType<typeof normalizeOptions>, contentItemIds: string[]): Prisma.QuestionUncheckedCreateInput {
  return {
    academyId: scope.academyId, kind: input.kind, status: input.status ?? "DRAFT", difficulty: input.difficulty ?? "INTERMEDIATE",
    questionHtml: rich(input.questionHtml), answerHtml: rich(input.answerHtml), caseHtml: rich(input.caseHtml), caseId: input.kind.startsWith("CASE_") ? randomUUID() : null,
    classificationMode: input.classificationMode ?? "ENTIRE_CASE", correctOptionId: input.correctOptionId?.toUpperCase(),
    correctExplanationHtml: rich(input.correctExplanationHtml), premiumWrongOptionsExplanationHtml: rich(input.premiumWrongOptionsExplanationHtml),
    courseId: input.courseId, subjectId: input.subjectId, chapterId: input.chapterId, lessonId: input.lessonId, topicId: input.topicId,
    practiceCollection: input.practiceCollection ?? "ORIGINAL", questionBankId: input.questionBankId ?? null, examName: input.examName?.trim() ?? "", chapterName: input.chapterName?.trim() ?? "", conceptName: input.conceptName?.trim() ?? "",
    options: options.length ? { create: options } : undefined,
    contentLinks: { create: contentItemIds.map((contentItemId) => ({ contentItemId })) },
    subQuestions: input.subQuestions?.length ? { create: input.subQuestions.map((sub, index) => ({ questionHtml: rich(sub.questionHtml), answerHtml: rich(sub.answerHtml), correctOptionId: sub.correctOptionId?.toUpperCase(), correctExplanationHtml: rich(sub.correctExplanationHtml), premiumWrongOptionsExplanationHtml: rich(sub.premiumWrongOptionsExplanationHtml), displayOrder: index, courseId: sub.courseId ?? input.courseId, subjectId: sub.subjectId ?? input.subjectId, chapterId: sub.chapterId ?? input.chapterId, lessonId: sub.lessonId ?? input.lessonId, topicId: sub.topicId ?? input.topicId, examName: sub.examName?.trim() ?? input.examName?.trim() ?? "", chapterName: sub.chapterName?.trim() ?? input.chapterName?.trim() ?? "", conceptName: sub.conceptName?.trim() ?? input.conceptName?.trim() ?? "", options: sub.options?.length ? { create: normalizeOptions(sub.options) } : undefined })) } : undefined,
  };
}

export async function createQuestion(scope: QuestionScope, input: QuestionInput) {
  const options = validateQuestionShape(input);
  return prisma.$transaction(async (tx) => {
    await validateTaxonomy(scope, input, tx);
    if (input.questionBankId) await assertQuestionBankForWrite(tx, scope, input.questionBankId, input.courseId!);
    const contentItemIds = await validateLinkedFiles(scope, input.courseId, input.contentItemIds, tx);
    for (const sub of input.subQuestions ?? []) await validateTaxonomy(scope, { courseId: sub.courseId ?? input.courseId, subjectId: sub.subjectId ?? input.subjectId, chapterId: sub.chapterId ?? input.chapterId, lessonId: sub.lessonId ?? input.lessonId, topicId: sub.topicId ?? input.topicId }, tx);
    const question = await tx.question.create({ data: questionData(scope, input, options, contentItemIds), include: fullInclude });
    await audit(tx, scope, "QUESTION_CREATED", question.id, "Created a question.");
    return question;
  });
}

export async function createQuestionsAtomically(scope: QuestionScope, inputs: QuestionInput[]) {
  if (!inputs.length) throw badRequest("EMPTY_IMPORT", "The import does not contain any questions.");
  return prisma.$transaction(async (tx) => {
    const created = [];
    for (const input of inputs) {
      const options = validateQuestionShape(input);
      await validateTaxonomy(scope, input, tx);
      if (input.questionBankId) await assertQuestionBankForWrite(tx, scope, input.questionBankId, input.courseId!);
      const contentItemIds = await validateLinkedFiles(scope, input.courseId, input.contentItemIds, tx);
      for (const sub of input.subQuestions ?? []) await validateTaxonomy(scope, { courseId: sub.courseId ?? input.courseId, subjectId: sub.subjectId ?? input.subjectId, chapterId: sub.chapterId ?? input.chapterId, lessonId: sub.lessonId ?? input.lessonId, topicId: sub.topicId ?? input.topicId }, tx);
      const question = await tx.question.create({ data: questionData(scope, input, options, contentItemIds), include: fullInclude });
      await audit(tx, scope, "QUESTION_IMPORTED", question.id, "Imported a validated question from an Excel workbook.");
      created.push(question);
    }
    return created;
  }, { timeout: 60_000 });
}

export async function updateQuestion(scope: QuestionScope, questionId: string, input: QuestionInput) {
  const options = validateQuestionShape(input);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.question.findFirst({ where: { id: questionId, deletedAt: null, ...scopeWhere(scope) } });
    if (!existing) throw notFound("QUESTION_NOT_FOUND", "The question was not found in the current scope.");
    if (existing.status === "ARCHIVED") throw conflict("QUESTION_ARCHIVED", "Restore the question before editing it.");
    await validateTaxonomy(scope, input, tx);
    if (input.questionBankId) await assertQuestionBankForWrite(tx, scope, input.questionBankId, input.courseId!);
    const contentItemIds = await validateLinkedFiles(scope, input.courseId, input.contentItemIds, tx);
    for (const sub of input.subQuestions ?? []) await validateTaxonomy(scope, { courseId: sub.courseId ?? input.courseId, subjectId: sub.subjectId ?? input.subjectId, chapterId: sub.chapterId ?? input.chapterId, lessonId: sub.lessonId ?? input.lessonId, topicId: sub.topicId ?? input.topicId }, tx);
    await tx.questionOption.deleteMany({ where: { questionId } });
    await tx.caseSubQuestion.deleteMany({ where: { questionId } });
    await tx.questionContentLink.deleteMany({ where: { questionId } });
    const data = questionData(scope, input, options, contentItemIds);
    delete (data as { academyId?: string }).academyId;
    const updated = await tx.question.update({ where: { id: questionId }, data, include: fullInclude });
    await audit(tx, scope, "QUESTION_UPDATED", questionId, "Updated a question and its answer structure.");
    return updated;
  });
}

export async function cloneQuestion(scope: QuestionScope, questionId: string) {
  const source = await getQuestion(scope, questionId);
  const input: QuestionInput = { kind: source.kind as QuestionInput["kind"], status: "DRAFT", difficulty: source.difficulty, practiceCollection: source.practiceCollection, questionBankId: source.questionBankId ?? undefined, questionHtml: source.questionHtml, answerHtml: source.answerHtml, caseHtml: source.caseHtml, classificationMode: source.classificationMode, correctOptionId: source.correctOptionId ?? undefined, correctExplanationHtml: source.correctExplanationHtml, premiumWrongOptionsExplanationHtml: source.premiumWrongOptionsExplanationHtml, courseId: source.courseId ?? undefined, contentItemIds: source.contentLinks.map((link) => link.contentItemId), subjectId: source.subjectId ?? undefined, chapterId: source.chapterId ?? undefined, lessonId: source.lessonId ?? undefined, topicId: source.topicId ?? undefined, examName: source.examName, chapterName: source.chapterName, conceptName: source.conceptName, options: source.options.map((option) => ({ optionLabel: option.optionLabel, html: option.html })), subQuestions: source.subQuestions.map((sub) => ({ questionHtml: sub.questionHtml, answerHtml: sub.answerHtml, correctOptionId: sub.correctOptionId ?? undefined, correctExplanationHtml: sub.correctExplanationHtml, premiumWrongOptionsExplanationHtml: sub.premiumWrongOptionsExplanationHtml, courseId: sub.courseId ?? undefined, subjectId: sub.subjectId ?? undefined, chapterId: sub.chapterId ?? undefined, lessonId: sub.lessonId ?? undefined, topicId: sub.topicId ?? undefined, examName: sub.examName, chapterName: sub.chapterName, conceptName: sub.conceptName, options: sub.options.map((option) => ({ optionLabel: option.optionLabel, html: option.html })) })) };
  return createQuestion(scope, input);
}

export async function setQuestionLifecycle(scope: QuestionScope, questionId: string, action: "archive" | "restore" | "publish") {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.question.findFirst({ where: { id: questionId, ...scopeWhere(scope) }, include: { _count: { select: { contentLinks: true } } } });
    if (!existing) throw notFound("QUESTION_NOT_FOUND", "The question was not found in the current scope.");
    if (action === "publish" && existing.practiceCollection !== "QUESTION_BANK" && ["NORMAL_MCQ", "CASE_MCQ"].includes(existing.kind) && existing._count.contentLinks < 1) throw conflict("QUESTION_FILES_REQUIRED", "Link at least one course file before publishing this question.");
    const data = action === "archive" ? { status: "ARCHIVED" as const, deletedAt: new Date() } : action === "restore" ? { status: "DRAFT" as const, deletedAt: null } : { status: "PUBLISHED" as const, deletedAt: null };
    const updated = await tx.question.update({ where: { id: questionId }, data, include: fullInclude });
    const auditAction = action === "publish" ? "QUESTION_PUBLISHED" : action === "archive" ? "QUESTION_ARCHIVED" : "QUESTION_RESTORED";
    await audit(tx, scope, auditAction, questionId, `${action} question.`);
    return updated;
  });
}

export async function permanentDeleteQuestion(scope: QuestionScope, questionId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.question.findFirst({ where: { id: questionId, ...scopeWhere(scope) } });
    if (!existing) throw notFound("QUESTION_NOT_FOUND", "The question was not found in the current scope.");

    await tx.questionOption.deleteMany({ where: { questionId } });
    await tx.caseSubQuestion.deleteMany({ where: { questionId } });
    await tx.question.delete({ where: { id: questionId } });

    await audit(tx, scope, "QUESTION_PERMANENTLY_DELETED", questionId, "Permanently deleted question from database.");
    return { id: questionId, deleted: true };
  });
}

export async function getTaxonomy(scope: QuestionScope, courseId: string) {
  const course = await prisma.course.findFirst({ where: { id: courseId, deletedAt: null, ...(scope.academyId ? { academyId: scope.academyId } : { academyId: null }) }, include: { subjects: { where: { deletedAt: null }, orderBy: { name: "asc" }, include: { taxonomyChapters: { orderBy: { name: "asc" }, include: { lessons: { orderBy: { name: "asc" }, include: { topics: { orderBy: { name: "asc" } } } } } } } } } });
  if (!course) throw notFound("COURSE_NOT_FOUND", "The taxonomy course was not found in the current scope.");
  return course;
}

export async function createTaxonomyNode(scope: QuestionScope, input: { kind: "subject" | "chapter" | "lesson" | "topic"; parentId: string; courseId: string; name: string }) {
  return prisma.$transaction(async (tx) => {
    await validateTaxonomy(scope, { courseId: input.courseId }, tx);
    let node: { id: string; name: string };
    if (input.kind === "subject") node = await tx.subject.create({ data: { courseId: input.courseId, name: input.name } });
    else if (input.kind === "chapter") {
      const subject = await tx.subject.findFirst({ where: { id: input.parentId, courseId: input.courseId, deletedAt: null } });
      if (!subject) throw notFound("SUBJECT_NOT_FOUND", "The subject was not found in the course.");
      node = await tx.taxonomyChapter.create({ data: { courseId: input.courseId, subjectId: subject.id, name: input.name } });
    } else if (input.kind === "lesson") {
      const chapter = await tx.taxonomyChapter.findFirst({ where: { id: input.parentId, courseId: input.courseId } });
      if (!chapter) throw notFound("CHAPTER_NOT_FOUND", "The chapter was not found in the course.");
      node = await tx.taxonomyLesson.create({ data: { chapterId: chapter.id, name: input.name } });
    } else {
      const lesson = await tx.taxonomyLesson.findFirst({ where: { id: input.parentId, chapter: { courseId: input.courseId } } });
      if (!lesson) throw notFound("LESSON_NOT_FOUND", "The lesson was not found in the course.");
      node = await tx.taxonomyTopic.create({ data: { lessonId: lesson.id, name: input.name } });
    }
    await tx.systemAuditLog.create({ data: { action: "TAXONOMY_NODE_CREATED", entityType: `Taxonomy${input.kind}`, entityId: node.id, actorId: scope.actorId, academyId: scope.academyId, description: `Created taxonomy ${input.kind} ${node.name}.` } });
    return node;
  });
}

export async function updateTaxonomyNode(scope: QuestionScope, kind: "subject" | "chapter" | "lesson" | "topic", nodeId: string, courseId: string, name: string) {
  await getTaxonomy(scope, courseId);
  if (kind === "subject") {
    const node = await prisma.subject.findFirst({ where: { id: nodeId, courseId, deletedAt: null } });
    if (!node) throw notFound("SUBJECT_NOT_FOUND", "The subject was not found in the current scope.");
    return prisma.subject.update({ where: { id: nodeId }, data: { name } });
  }
  if (kind === "chapter") {
    const node = await prisma.taxonomyChapter.findFirst({ where: { id: nodeId, courseId } });
    if (!node) throw notFound("CHAPTER_NOT_FOUND", "The chapter was not found in the current scope.");
    return prisma.taxonomyChapter.update({ where: { id: nodeId }, data: { name } });
  }
  if (kind === "lesson") {
    const node = await prisma.taxonomyLesson.findFirst({ where: { id: nodeId, chapter: { courseId } } });
    if (!node) throw notFound("LESSON_NOT_FOUND", "The lesson was not found in the current scope.");
    return prisma.taxonomyLesson.update({ where: { id: nodeId }, data: { name } });
  }
  const node = await prisma.taxonomyTopic.findFirst({ where: { id: nodeId, lesson: { chapter: { courseId } } } });
  if (!node) throw notFound("TOPIC_NOT_FOUND", "The topic was not found in the current scope.");
  return prisma.taxonomyTopic.update({ where: { id: nodeId }, data: { name } });
}

export async function deleteTaxonomyNode(scope: QuestionScope, kind: "subject" | "chapter" | "lesson" | "topic", nodeId: string, courseId: string) {
  await getTaxonomy(scope, courseId);
  if (kind === "subject") {
    const node = await prisma.subject.findFirst({ where: { id: nodeId, courseId, deletedAt: null }, include: { _count: { select: { taxonomyChapters: true, questions: true } } } });
    if (!node) throw notFound("SUBJECT_NOT_FOUND", "The subject was not found in the current scope.");
    if (node._count.taxonomyChapters || node._count.questions) throw conflict("TAXONOMY_NODE_IN_USE", "The subject cannot be archived while it has chapters or questions.");
    return prisma.subject.update({ where: { id: nodeId }, data: { deletedAt: new Date() } });
  }
  if (kind === "chapter") {
    const node = await prisma.taxonomyChapter.findFirst({ where: { id: nodeId, courseId }, include: { _count: { select: { lessons: true, questions: true } } } });
    if (!node) throw notFound("CHAPTER_NOT_FOUND", "The chapter was not found in the current scope.");
    if (node._count.lessons || node._count.questions) throw conflict("TAXONOMY_NODE_IN_USE", "The chapter cannot be deleted while it has lessons or questions.");
    await prisma.taxonomyChapter.delete({ where: { id: nodeId } }); return { id: nodeId, deleted: true };
  }
  if (kind === "lesson") {
    const node = await prisma.taxonomyLesson.findFirst({ where: { id: nodeId, chapter: { courseId } }, include: { _count: { select: { topics: true, questions: true } } } });
    if (!node) throw notFound("LESSON_NOT_FOUND", "The lesson was not found in the current scope.");
    if (node._count.topics || node._count.questions) throw conflict("TAXONOMY_NODE_IN_USE", "The lesson cannot be deleted while it has topics or questions.");
    await prisma.taxonomyLesson.delete({ where: { id: nodeId } }); return { id: nodeId, deleted: true };
  }
  const node = await prisma.taxonomyTopic.findFirst({ where: { id: nodeId, lesson: { chapter: { courseId } } }, include: { _count: { select: { questions: true } } } });
  if (!node) throw notFound("TOPIC_NOT_FOUND", "The topic was not found in the current scope.");
  if (node._count.questions) throw conflict("TAXONOMY_NODE_IN_USE", "The topic cannot be deleted while it has questions.");
  await prisma.taxonomyTopic.delete({ where: { id: nodeId } }); return { id: nodeId, deleted: true };
}

export async function listStudentQuestions(
  actorId: string,
  academyId: string | undefined,
  input: {
    courseId?: string;
    subjectId?: string;
    chapterId?: string;
    lessonId?: string;
    topicId?: string;
    kind?: QuestionInput["kind"];
    difficulty?: QuestionInput["difficulty"];
    page: number;
    limit: number;
  }
) {
  if (academyId) {
    const membership = await prisma.academyMembership.findFirst({
      where: { userId: actorId, academyId, role: "ACADEMY_STUDENT", status: "ACTIVE", academy: { status: "ACTIVE", deletedAt: null } },
      select: { id: true },
    });
    if (!membership) throw notFound("ACADEMY_QUESTIONS_NOT_FOUND", "The requested question bank was not found.");
  }
  const resolvedCourseId = input.courseId ?? (await prisma.learnerPreference.findUnique({ where: { userId: actorId }, select: { selectedCourseId: true } }))?.selectedCourseId ?? undefined;
  if (resolvedCourseId) {
    const course = await prisma.course.findFirst({
      where: { id: resolvedCourseId, deletedAt: null, academyId: academyId ?? null },
      select: { id: true },
    });
    if (!course) throw notFound("COURSE_NOT_FOUND", "The requested course was not found.");
  }
  if (!resolvedCourseId) throw badRequest("COURSE_REQUIRED", "Select a course before loading practice questions.");
  const accessibleContentIds = [...await accessibleContentIdsForCourse(actorId, resolvedCourseId)];

  const where: Prisma.QuestionWhereInput = {
    status: "PUBLISHED",
    deletedAt: null,
    academyId: academyId ?? null,
    courseId: resolvedCourseId,
    kind: input.kind && ["NORMAL_MCQ", "CASE_MCQ"].includes(input.kind) ? input.kind : { in: ["NORMAL_MCQ", "CASE_MCQ"] },
    contentLinks: { some: { contentItemId: { in: accessibleContentIds } } },
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    ...(input.chapterId ? { chapterId: input.chapterId } : {}),
    ...(input.lessonId ? { lessonId: input.lessonId } : {}),
    ...(input.topicId ? { topicId: input.topicId } : {}),
    ...(input.difficulty ? { difficulty: input.difficulty } : {}),
  };

  const [rawQuestions, total] = await Promise.all([
    prisma.question.findMany({
      where,
      skip: (input.page - 1) * input.limit,
      take: input.limit,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: {
        options: { orderBy: { displayOrder: "asc" } },
        subQuestions: {
          orderBy: { displayOrder: "asc" },
          include: { options: { orderBy: { displayOrder: "asc" } } },
        },
        course: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true } },
        chapter: { select: { id: true, name: true } },
        lesson: { select: { id: true, name: true } },
        topic: { select: { id: true, name: true } },
      },
    }),
    prisma.question.count({ where }),
  ]);

  const data = rawQuestions.map((q) => ({
    id: q.id,
    kind: q.kind,
    difficulty: q.difficulty,
    questionHtml: q.questionHtml,
    answerHtml: q.answerHtml,
    caseHtml: q.caseHtml,
    caseId: q.caseId,
    classificationMode: q.classificationMode,
    options: q.options.map((opt) => ({
      id: opt.optionLabel,
      optionLabel: opt.optionLabel,
      html: opt.html,
      displayOrder: opt.displayOrder,
    })),
    subQuestions: q.subQuestions.map((sub) => ({
      id: sub.id,
      questionHtml: sub.questionHtml,
      answerHtml: sub.answerHtml,
      options: sub.options.map((opt) => ({
        id: opt.optionLabel,
        optionLabel: opt.optionLabel,
        html: opt.html,
        displayOrder: opt.displayOrder,
      })),
      displayOrder: sub.displayOrder,
    })),
    classification: {
      courseId: q.courseId,
      subjectId: q.subjectId,
      chapterId: q.chapterId,
      lessonId: q.lessonId,
      topicId: q.topicId,
      courseName: q.course?.name,
      subjectName: q.subject?.name,
      chapterName: q.chapter?.name,
      lessonName: q.lesson?.name,
      topicName: q.topic?.name,
    },
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  }));

  return {
    data,
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      totalPages: Math.ceil(total / input.limit),
    },
  };
}
