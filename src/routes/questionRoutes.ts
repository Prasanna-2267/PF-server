import { Router } from "express";
import { z } from "zod";
import { asyncRoute } from "../middleware/async-route.js";
import * as questions from "../services/questionService.js";
import * as imports from "../services/questionImportService.js";
import * as banks from "../services/questionBankService.js";

const uuid = z.string().uuid();
const option = z.object({
  id: z.string().optional(),
  optionLabel: z.string().optional(),
  html: z.string().min(1).max(10_000),
}).transform((opt) => ({
  optionLabel: (opt.optionLabel || opt.id || "A").toUpperCase(),
  html: opt.html,
}));

const classificationSchema = z.object({
  courseId: uuid.optional().nullable(),
  subjectId: uuid.optional().nullable(),
  chapterId: uuid.optional().nullable(),
  lessonId: uuid.optional().nullable(),
  topicId: uuid.optional().nullable(),
}).optional().nullable();

const taxonomyFields = {
  courseId: uuid.optional().nullable(),
  subjectId: uuid.optional().nullable(),
  chapterId: uuid.optional().nullable(),
  lessonId: uuid.optional().nullable(),
  topicId: uuid.optional().nullable(),
  examName: z.string().trim().max(160).optional().nullable(),
  chapterName: z.string().trim().max(240).optional().nullable(),
  conceptName: z.string().trim().max(240).optional().nullable(),
};

const subQuestion = z.object({
  questionHtml: z.string().min(1).max(50_000),
  answerHtml: z.string().max(50_000).optional().nullable(),
  correctOptionId: z.string().regex(/^[A-D]$/i).optional().nullable(),
  correctExplanationHtml: z.string().max(50_000).optional().nullable(),
  premiumWrongOptionsExplanationHtml: z.string().max(50_000).optional().nullable(),
  classification: classificationSchema,
  ...taxonomyFields,
  options: z.array(option).min(2).max(4).optional().nullable(),
}).transform((sub) => ({
  questionHtml: sub.questionHtml,
  answerHtml: sub.answerHtml || undefined,
  correctOptionId: sub.correctOptionId || undefined,
  correctExplanationHtml: sub.correctExplanationHtml || undefined,
  premiumWrongOptionsExplanationHtml: sub.premiumWrongOptionsExplanationHtml || undefined,
  courseId: sub.courseId || sub.classification?.courseId || undefined,
  subjectId: sub.subjectId || sub.classification?.subjectId || undefined,
  chapterId: sub.chapterId || sub.classification?.chapterId || undefined,
  lessonId: sub.lessonId || sub.classification?.lessonId || undefined,
  topicId: sub.topicId || sub.classification?.topicId || undefined,
  examName: sub.examName || undefined,
  chapterName: sub.chapterName || undefined,
  conceptName: sub.conceptName || undefined,
  options: sub.options || undefined,
}));

const question = z.object({
  kind: z.enum(["NORMAL_MCQ", "CASE_MCQ"]),
  status: z.enum(["DRAFT", "PUBLISHED"]).optional(),
  difficulty: z.enum(["FOUNDATION", "INTERMEDIATE", "ADVANCED"]).optional(),
  practiceCollection: z.enum(["PYQ", "RTP", "MTP", "ORIGINAL", "QUESTION_BANK"]).optional(),
  questionBankId: uuid.optional().nullable(),
  questionHtml: z.string().max(50_000).optional().nullable(),
  answerHtml: z.string().max(50_000).optional().nullable(),
  caseHtml: z.string().max(100_000).optional().nullable(),
  classificationMode: z.enum(["ENTIRE_CASE", "INDIVIDUAL_SUB_QUESTIONS"]).optional(),
  correctOptionId: z.string().regex(/^[A-D]$/i).optional().nullable(),
  correctExplanationHtml: z.string().max(50_000).optional().nullable(),
  premiumWrongOptionsExplanationHtml: z.string().max(50_000).optional().nullable(),
  classification: classificationSchema,
  ...taxonomyFields,
  contentItemIds: z.array(uuid).max(100).default([]),
  options: z.array(option).min(2).max(4).optional().nullable(),
  subQuestions: z.array(subQuestion).min(1).max(50).optional().nullable(),
}).transform((q) => ({
  kind: q.kind,
  status: q.status,
  difficulty: q.difficulty,
  practiceCollection: q.practiceCollection,
  questionBankId: q.questionBankId || undefined,
  questionHtml: q.questionHtml || undefined,
  answerHtml: q.answerHtml || undefined,
  caseHtml: q.caseHtml || undefined,
  classificationMode: q.classificationMode,
  correctOptionId: q.correctOptionId || undefined,
  correctExplanationHtml: q.correctExplanationHtml || undefined,
  premiumWrongOptionsExplanationHtml: q.premiumWrongOptionsExplanationHtml || undefined,
  courseId: q.courseId || q.classification?.courseId || undefined,
  subjectId: q.subjectId || q.classification?.subjectId || undefined,
  chapterId: q.chapterId || q.classification?.chapterId || undefined,
  lessonId: q.lessonId || q.classification?.lessonId || undefined,
  topicId: q.topicId || q.classification?.topicId || undefined,
  examName: q.examName || undefined,
  chapterName: q.chapterName || undefined,
  conceptName: q.conceptName || undefined,
  contentItemIds: q.contentItemIds,
  options: q.options || undefined,
  subQuestions: q.subQuestions || undefined,
}));

const academyScope = (req: Express.Request) => ({ academyId: req.tenantContext!.academyId!, actorId: req.auth!.userId });
const adminScope = (req: Express.Request) => ({ actorId: req.auth!.userId });

export function createQuestionRouter(kind: "admin" | "academy") {
  const router = Router();
  const scope = kind === "admin" ? adminScope : academyScope;

  router.get("/files", asyncRoute(async (req, res) => {
    const query = z.object({ courseId: uuid, search: z.string().trim().max(120).optional() }).parse(req.query);
    res.json(await questions.listQuestionFiles(scope(req), query));
  }));

  router.get("/templates/:mode", asyncRoute(async (req, res) => {
    const mode = z.enum(["normal", "case"]).parse(req.params.mode);
    const workbook = await imports.buildTemplate(mode);
    res.json({ fileName: `questions-${mode}-template.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", contentBase64: workbook.toString("base64") });
  }));

  const importBody = z.object({
    courseId: uuid,
    mode: z.enum(["normal", "case"]),
    practiceCollection: z.enum(["ORIGINAL", "QUESTION_BANK"]).optional(),
    questionBankId: uuid.optional(),
    fileName: z.string().trim().min(1).max(240),
    contentBase64: z.string().min(1).max(30_000_000),
  }).strict();
  router.post("/imports/validate", asyncRoute(async (req, res) => {
    res.json(await imports.validateImport(scope(req), importBody.parse(req.body)));
  }));
  router.post("/imports/commit", asyncRoute(async (req, res) => {
    const body = importBody.extend({ validationDigest: z.string().length(64) }).parse(req.body);
    res.status(201).json(await imports.commitImport(scope(req), body));
  }));

  router.get("/taxonomy", asyncRoute(async (req, res) => {
    const query = z.object({ courseId: uuid }).parse(req.query);
    res.json(await questions.getTaxonomy(scope(req), query.courseId));
  }));

  const bankBody = z.object({
    courseId: uuid,
    name: z.string().trim().min(2).max(160),
    description: z.string().trim().max(2_000).optional(),
    accessType: z.enum(["FREE", "PAID"]),
    price: z.coerce.number().finite().min(0).max(10_000_000).optional().nullable(),
    accessDurationValue: z.coerce.number().int().min(1).max(3_650).optional().nullable(),
    accessDurationUnit: z.enum(["DAYS", "WEEKS", "MONTHS"]).optional().nullable(),
  }).strict();

  router.get("/banks", asyncRoute(async (req, res) => {
    const query = z.object({ courseId: uuid, includeArchived: z.coerce.boolean().optional() }).parse(req.query);
    res.json(await banks.listQuestionBanks(scope(req), query));
  }));

  router.post("/banks", asyncRoute(async (req, res) => {
    const parsed = bankBody.parse(req.body);
    res.status(201).json(await banks.createQuestionBank(scope(req), kind === "academy" ? { ...parsed, accessType: "FREE", price: null, accessDurationValue: null, accessDurationUnit: null } : parsed));
  }));

  router.get("/banks/:bankId", asyncRoute(async (req, res) => {
    res.json(await banks.getQuestionBank(scope(req), uuid.parse(req.params.bankId)));
  }));

  router.patch("/banks/:bankId", asyncRoute(async (req, res) => {
    const parsed = bankBody.parse(req.body);
    res.json(await banks.updateQuestionBank(scope(req), uuid.parse(req.params.bankId), kind === "academy" ? { ...parsed, accessType: "FREE", price: null, accessDurationValue: null, accessDurationUnit: null } : parsed));
  }));

  router.delete("/banks/:bankId", asyncRoute(async (req, res) => {
    res.json(await banks.deleteQuestionBank(scope(req), uuid.parse(req.params.bankId)));
  }));

  for (const action of ["publish", "archive", "restore"] as const) {
    router.post(`/banks/:bankId/${action}`, asyncRoute(async (req, res) => {
      res.json(await banks.setQuestionBankLifecycle(scope(req), uuid.parse(req.params.bankId), action));
    }));
  }

  router.post("/taxonomy/:nodeKind", asyncRoute(async (req, res) => {
    const nodeKind = z.enum(["subject", "chapter", "lesson", "topic"]).parse(req.params.nodeKind);
    const body = z.object({ courseId: uuid, parentId: uuid, name: z.string().trim().min(1).max(160) }).strict().parse(req.body);
    res.status(201).json(await questions.createTaxonomyNode(scope(req), { kind: nodeKind, ...body }));
  }));

  router.patch("/taxonomy/:nodeKind/:nodeId", asyncRoute(async (req, res) => {
    const nodeKind = z.enum(["subject", "chapter", "lesson", "topic"]).parse(req.params.nodeKind);
    const body = z.object({ courseId: uuid, name: z.string().trim().min(1).max(160) }).strict().parse(req.body);
    res.json(await questions.updateTaxonomyNode(scope(req), nodeKind, uuid.parse(req.params.nodeId), body.courseId, body.name));
  }));

  router.delete("/taxonomy/:nodeKind/:nodeId", asyncRoute(async (req, res) => {
    const nodeKind = z.enum(["subject", "chapter", "lesson", "topic"]).parse(req.params.nodeKind);
    const query = z.object({ courseId: uuid }).parse(req.query);
    res.json(await questions.deleteTaxonomyNode(scope(req), nodeKind, uuid.parse(req.params.nodeId), query.courseId));
  }));

  router.get("/", asyncRoute(async (req, res) => {
    const query = z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).optional(),
      kind: z.enum(["NORMAL_MCQ", "CASE_MCQ"]).optional(),
      practiceCollection: z.enum(["PYQ", "RTP", "MTP", "ORIGINAL", "QUESTION_BANK"]).optional(),
      questionBankId: uuid.optional(),
      difficulty: z.enum(["FOUNDATION", "INTERMEDIATE", "ADVANCED"]).optional(),
      courseId: uuid,
      contentItemId: uuid.optional(),
      examName: z.string().trim().max(160).optional(),
      chapterName: z.string().trim().max(240).optional(),
      createdFrom: z.coerce.date().optional(),
      createdTo: z.coerce.date().optional(),
      updatedFrom: z.coerce.date().optional(),
      updatedTo: z.coerce.date().optional(),
      search: z.string().trim().max(120).optional(),
      includeDeleted: z.coerce.boolean().optional(),
    }).parse(req.query);

    res.json(await questions.listQuestions(scope(req), query));
  }));

  router.post("/", asyncRoute(async (req, res) => {
    res.status(201).json(await questions.createQuestion(scope(req), question.parse(req.body)));
  }));

  router.get("/:questionId", asyncRoute(async (req, res) => {
    res.json(await questions.getQuestion(scope(req), uuid.parse(req.params.questionId)));
  }));

  router.put("/:questionId", asyncRoute(async (req, res) => {
    res.json(await questions.updateQuestion(scope(req), uuid.parse(req.params.questionId), question.parse(req.body)));
  }));

  router.post("/:questionId/clone", asyncRoute(async (req, res) => {
    res.status(201).json(await questions.cloneQuestion(scope(req), uuid.parse(req.params.questionId)));
  }));

  for (const action of ["archive", "restore", "publish"] as const) {
    router.post(`/:questionId/${action}`, asyncRoute(async (req, res) => {
      res.json(await questions.setQuestionLifecycle(scope(req), uuid.parse(req.params.questionId), action));
    }));
  }

  router.delete("/:questionId", asyncRoute(async (req, res) => {
    res.json(await questions.permanentDeleteQuestion(scope(req), uuid.parse(req.params.questionId)));
  }));

  return router;
}
