import { Prisma, type PracticeAnswerFormat, type PracticeCollection, type PracticeMode, type QuestionKind } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { badRequest, conflict, forbidden, notFound } from "../errors/api-error.js";
import { learnerDateKey } from "./learnerTime.js";
import { accessibleContentIdsForCourse } from "./noteCatalogService.js";
import { expandedPackageContentIds, publishedCourseContent } from "./packageContentService.js";
import { generateStudyPlan } from "./studyPlanService.js";
import { logger } from "../observability/logger.js";

type SourceInput = { sourceKind: "ARCHIVE"; mode?: PracticeMode; questionBankId?: string };
type FilterInput = SourceInput & {
  mode?: PracticeMode;
  contentItemIds?: string[];
  questionBankId?: string;
  subjectId?: string;
  chapterId?: string;
  lessonId?: string;
  topicId?: string;
  collection?: PracticeCollection;
  year?: number;
  answerFormat: PracticeAnswerFormat;
  questionCount?: number;
  timerSeconds?: number;
};
type PracticeCandidate = {
  questionId: string;
  subQuestionId: string | null;
  kind: QuestionKind;
  difficulty: "FOUNDATION" | "INTERMEDIATE" | "ADVANCED";
  promptHtml: string;
  caseHtml: string;
  options: Array<{ optionLabel: string; html: string; displayOrder: number }>;
  correctOptionLabel: string | null;
  answerHtml: string;
  correctExplanationHtml: string;
  premiumWrongExplanationHtml: string;
  subjectId: string | null;
  chapterId: string | null;
  lessonId: string | null;
  topicId: string | null;
  examName: string;
  chapterName: string;
  conceptName: string;
};

async function selectedCourse(userId: string) {
  const preference = await prisma.learnerPreference.findUnique({ where: { userId }, select: { selectedCourse: { select: { id: true, code: true, name: true, slug: true, academyId: true, status: true, deletedAt: true, academy: { select: { status: true, deletedAt: true } } } } } });
  const course = preference?.selectedCourse;
  if (!course || course.status !== "ACTIVE" || course.deletedAt || (course.academy && (course.academy.status !== "ACTIVE" || course.academy.deletedAt))) throw conflict("COURSE_NOT_SELECTED", "Select an active course before starting practice.");
  if (course.academyId && !await prisma.academyMembership.findFirst({ where: { userId, academyId: course.academyId, role: "ACADEMY_STUDENT", status: "ACTIVE" }, select: { id: true } })) throw forbidden("ACADEMY_MEMBERSHIP_REQUIRED", "This academy course is no longer available to your account.");
  return course;
}

const activeWindow = () => ({ status: "ACTIVE" as const, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] });

type QuestionBankAccess = {
  source: "DIRECT_PURCHASE" | "PACKAGE";
  packageId: string | null;
  packageTitle: string | null;
};

/**
 * Resolves paid Question Bank access from the two supported ownership paths:
 * a direct Question Bank entitlement or an entitlement to a package containing
 * that bank. Direct ownership wins when both records exist.
 */
async function questionBankAccess(userId: string, questionBankIds: string[]) {
  const ids = [...new Set(questionBankIds)];
  const access = new Map<string, QuestionBankAccess>();
  if (!ids.length) return access;

  const entitlements = await prisma.entitlement.findMany({
    where: {
      userId,
      ...activeWindow(),
      OR: [
        { questionBankId: { in: ids } },
        { package: { questionBanks: { some: { questionBankId: { in: ids } } } } },
      ],
    },
    select: {
      questionBankId: true,
      package: {
        select: {
          id: true,
          title: true,
          questionBanks: {
            where: { questionBankId: { in: ids } },
            select: { questionBankId: true },
          },
        },
      },
    },
    take: 10_000,
  });

  for (const entitlement of entitlements) {
    if (entitlement.questionBankId) {
      access.set(entitlement.questionBankId, { source: "DIRECT_PURCHASE", packageId: null, packageTitle: null });
    }
  }
  for (const entitlement of entitlements) {
    if (!entitlement.package) continue;
    for (const membership of entitlement.package.questionBanks) {
      if (!access.has(membership.questionBankId)) {
        access.set(membership.questionBankId, {
          source: "PACKAGE",
          packageId: entitlement.package.id,
          packageTitle: entitlement.package.title,
        });
      }
    }
  }
  return access;
}

async function entitledPracticeContentIds(userId: string, courseId: string) {
  const [entitlements, courseContent] = await Promise.all([
    prisma.entitlement.findMany({
      where: {
        userId,
        ...activeWindow(),
        OR: [{ contentItem: { courseId } }, { package: { courseId } }],
      },
      select: {
        contentItemId: true,
        package: { select: { items: { select: { contentItemId: true } } } },
      },
      take: 10_000,
    }),
    publishedCourseContent(courseId),
  ]);
  const directIds = entitlements.flatMap((row) => row.contentItemId ? [row.contentItemId] : []);
  const packageRootIds = entitlements.flatMap((row) => row.package?.items.map((item) => item.contentItemId) ?? []);
  return new Set([...directIds, ...expandedPackageContentIds(courseContent, packageRootIds)]);
}

async function hasPaidPracticePolicy(userId: string) {
  return Boolean(await prisma.entitlement.findFirst({
    where: {
      userId,
      ...activeWindow(),
      OR: [{ source: "SUBSCRIPTION" }, { source: "PURCHASE", order: { status: "PAID", isComplimentary: false, totalAmount: { gt: 0 } } }],
    },
    select: { id: true },
  }));
}

function authorizedQuestionAccess(userId: string, accessibleContentIds: string[]): Prisma.QuestionWhereInput {
  return {
    OR: [
      {
        practiceCollection: { not: "QUESTION_BANK" },
        contentLinks: { some: { contentItemId: { in: accessibleContentIds } } },
      },
      {
        practiceCollection: "QUESTION_BANK",
        questionBank: {
          is: {
            status: "PUBLISHED",
            deletedAt: null,
            OR: [
              { accessType: "FREE" },
              {
                accessType: "PAID",
                OR: [
                  {
                    entitlements: {
                      some: {
                        userId,
                        status: "ACTIVE",
                        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
                      },
                    },
                  },
                  {
                    packages: {
                      some: {
                        package: {
                          entitlements: {
                            some: {
                              userId,
                              status: "ACTIVE",
                              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
                            },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    ],
  };
}

const isReviewMode = (mode: PracticeMode) => mode === "WRONG_ANSWERS" || mode === "REVISIT";
const pairKey = (questionId: string, subQuestionId: string | null) => `${questionId}:${subQuestionId ?? ""}`;

async function practiceHistoryPairs(userId: string, courseId: string) {
  const select = { questionId: true, subQuestionId: true } as const;
  const [correctRows, wrongRows, attemptedNormalRows] = await Promise.all([
    prisma.practiceSessionQuestion.findMany({ where: { session: { userId, courseId }, attempts: { some: { userId, correct: true } } }, distinct: ["questionId", "subQuestionId"], select }),
    prisma.practiceSessionQuestion.findMany({ where: { session: { userId, courseId }, attempts: { some: { userId, correct: false } } }, distinct: ["questionId", "subQuestionId"], select }),
    prisma.practiceSessionQuestion.findMany({ where: { session: { userId, courseId, mode: { in: ["MCQ", "CASE_STUDY"] } }, attempts: { some: { userId, correct: { not: null } } } }, distinct: ["questionId", "subQuestionId"], select }),
  ]);
  const correct = new Set(correctRows.map((row) => pairKey(row.questionId, row.subQuestionId)));
  return {
    correct,
    wrong: new Set(wrongRows.map((row) => pairKey(row.questionId, row.subQuestionId)).filter((key) => !correct.has(key))),
    attemptedNormal: new Set(attemptedNormalRows.map((row) => pairKey(row.questionId, row.subQuestionId))),
  };
}

function parentIdsForPairs(pairs: Set<string>) {
  return [...new Set([...pairs].map((key) => key.slice(0, key.indexOf(":"))))];
}

function normalMcqQuestionIds(pairs: Set<string>) {
  return [...pairs].filter((key) => key.endsWith(":")).map((key) => key.slice(0, -1));
}

function questionWhere(userId: string, courseId: string, academyId: string | null, input: FilterInput, accessibleContentIds: string[], historyQuestionIds?: string[], excludedQuestionIds?: string[]): Prisma.QuestionWhereInput {
  const mode = input.mode ?? (input.answerFormat === "CASE_STUDY" ? "CASE_STUDY" : "MCQ");
  const kinds: QuestionKind[] = mode === "QUESTION_BANK" || isReviewMode(mode)
    ? ["NORMAL_MCQ", "CASE_MCQ"]
    : mode === "CASE_STUDY"
      ? ["CASE_MCQ"]
      : ["NORMAL_MCQ"];
  const selectedIds = input.contentItemIds?.length ? input.contentItemIds : undefined;
  const bankOwnsAccess = mode === "QUESTION_BANK";
  return {
    courseId,
    academyId,
    status: "PUBLISHED",
    deletedAt: null,
    AND: [
      ...(bankOwnsAccess ? [] : isReviewMode(mode) ? [authorizedQuestionAccess(userId, accessibleContentIds)] : [{ contentLinks: { some: { contentItemId: { in: accessibleContentIds } } } }]),
      ...(selectedIds ? [{ contentLinks: { some: { contentItemId: { in: selectedIds } } } }] : []),
    ],
    kind: { in: kinds },
    ...(historyQuestionIds ? { id: { in: historyQuestionIds } } : {}),
    ...(excludedQuestionIds?.length ? { NOT: { id: { in: excludedQuestionIds } } } : {}),
    ...(mode === "QUESTION_BANK" ? { practiceCollection: "QUESTION_BANK" } : isReviewMode(mode) ? {} : { practiceCollection: { not: "QUESTION_BANK" } }),
    ...(input.questionBankId ? { questionBankId: input.questionBankId } : {}),
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    ...(input.chapterId ? { chapterId: input.chapterId } : {}),
    ...(input.lessonId ? { lessonId: input.lessonId } : {}),
    ...(input.topicId ? { topicId: input.topicId } : {}),
    ...(input.collection ? { practiceCollection: input.collection } : {}),
    ...(input.year ? { practiceYear: input.year } : {}),
    ...(mode === "CASE_STUDY" ? { subQuestions: { some: {} } } : {}),
  };
}

async function validateSource(userId: string, input: SourceInput) {
  const course = await selectedCourse(userId);
  return { course, policy: await hasPaidPracticePolicy(userId) ? "PAID" as const : "FREE" as const };
}

function validateFilterRules(input: FilterInput) {
  const mode = input.mode ?? (input.answerFormat === "CASE_STUDY" ? "CASE_STUDY" : "MCQ");
  if (input.answerFormat === "DESCRIPTIVE") throw badRequest("PRACTICE_FORMAT_NOT_AVAILABLE", "Descriptive practice is not available in this workflow.");
  if (mode === "CASE_STUDY" && input.answerFormat !== "CASE_STUDY") throw badRequest("INVALID_PRACTICE_MODE", "Case Study mode requires the case-study answer format.");
  if (mode !== "CASE_STUDY" && mode !== "QUESTION_BANK" && input.answerFormat !== "MCQ") throw badRequest("INVALID_PRACTICE_MODE", "This practice mode requires MCQ questions.");
  if (input.contentItemIds && (input.contentItemIds.length < 1 || input.contentItemIds.length > 100)) throw badRequest("INVALID_PRACTICE_MATERIALS", "Choose between 1 and 100 materials.");
  if (mode === "QUESTION_BANK" && !input.questionBankId) throw badRequest("QUESTION_BANK_REQUIRED", "Choose a Question Bank before building this practice set.");
  if (mode !== "QUESTION_BANK" && input.questionBankId) throw badRequest("QUESTION_BANK_NOT_ALLOWED", "questionBankId is only valid in Question Bank mode.");
  if (input.year !== undefined && (input.year < 1900 || input.year > 2100)) throw badRequest("INVALID_PRACTICE_YEAR", "Choose a valid Archive year.");
  if (input.questionCount !== undefined && (input.questionCount < 1 || input.questionCount > 100)) throw badRequest("INVALID_QUESTION_COUNT", "Choose between 1 and 100 questions, or omit the limit for an unlimited session.");
  if (input.timerSeconds !== undefined && (input.timerSeconds < 30 || input.timerSeconds > 86_400)) throw badRequest("INVALID_PRACTICE_TIMER", "Choose a timer between 30 seconds and 24 hours, or turn it off.");
}

export async function listPracticeSources(userId: string) {
  const course = await selectedCourse(userId);
  const accessibleContentIds = [...await accessibleContentIdsForCourse(userId, course.id)];
  const visible: Prisma.QuestionWhereInput = { courseId: course.id, academyId: course.academyId, status: "PUBLISHED", deletedAt: null, kind: { in: ["NORMAL_MCQ", "CASE_MCQ"] }, practiceCollection: { not: "QUESTION_BANK" }, contentLinks: { some: { contentItemId: { in: accessibleContentIds } } } };
  const [questionCount, years] = await Promise.all([
    prisma.question.count({ where: visible }),
    prisma.question.findMany({ where: { ...visible, practiceYear: { not: null } }, distinct: ["practiceYear"], orderBy: { practiceYear: "desc" }, select: { practiceYear: true }, take: 100 }),
  ]);
  return {
    course: { id: course.id, code: course.code, name: course.name },
    practice: { id: "practice", kind: "ARCHIVE" as const, title: "Practice questions", free: true, questionCount, years: years.flatMap((item) => item.practiceYear === null ? [] : [item.practiceYear]) },
  };
}

export async function listPracticeModes(userId: string) {
  const course = await selectedCourse(userId);
  const accessibleSet = await accessibleContentIdsForCourse(userId, course.id);
  const accessible = [...accessibleSet];
  const common: Prisma.QuestionWhereInput = { courseId: course.id, academyId: course.academyId, status: "PUBLISHED", deletedAt: null, contentLinks: { some: { contentItemId: { in: accessible } } } };
  const authorizedWrong: Prisma.QuestionWhereInput = { courseId: course.id, academyId: course.academyId, status: "PUBLISHED", deletedAt: null, ...authorizedQuestionAccess(userId, accessible) };
  const [newQuestions, accessibleBanks, history, authorizedHistoryQuestions] = await Promise.all([
    prisma.question.findMany({ where: { ...common, kind: { in: ["NORMAL_MCQ", "CASE_MCQ"] }, practiceCollection: { not: "QUESTION_BANK" } }, select: { id: true, kind: true, subQuestions: { select: { id: true } } } }),
    listQuestionBanks(userId),
    practiceHistoryPairs(userId, course.id),
    prisma.question.findMany({ where: { ...authorizedWrong, kind: { in: ["NORMAL_MCQ", "CASE_MCQ"] } }, select: { id: true, kind: true, subQuestions: { select: { id: true } } } }),
  ]);
  const newPairs = newQuestions.flatMap((question) => question.kind === "CASE_MCQ" ? question.subQuestions.map((sub) => ({ kind: question.kind, key: pairKey(question.id, sub.id) })) : [{ kind: question.kind, key: pairKey(question.id, null) }]);
  const authorizedHistoryPairs = new Set(authorizedHistoryQuestions.flatMap((question) => question.kind === "CASE_MCQ" ? question.subQuestions.map((sub) => pairKey(question.id, sub.id)) : [pairKey(question.id, null)]));
  const mcq = newPairs.filter((entry) => entry.kind === "NORMAL_MCQ" && !history.attemptedNormal.has(entry.key)).length;
  const cases = newPairs.filter((entry) => entry.kind === "CASE_MCQ" && !history.attemptedNormal.has(entry.key)).length;
  const wrong = [...history.wrong].filter((key) => authorizedHistoryPairs.has(key)).length;
  const revisit = [...history.correct].filter((key) => authorizedHistoryPairs.has(key)).length;
  const accessibleBankQuestions = accessibleBanks
    .filter((bank) => !bank.locked)
    .reduce((total, bank) => total + bank.questionCount, 0);
  return {
    course: { id: course.id, code: course.code, name: course.name },
    modes: [
      { id: "MCQ" as const, title: "MCQ", description: "Focused questions from your accessible course files.", availableCount: mcq, locked: false },
      { id: "CASE_STUDY" as const, title: "Case Study", description: "Read a case once and work through its linked sub-questions.", availableCount: cases, locked: false },
      { id: "QUESTION_BANK" as const, title: "Question Bank", description: "Browse free banks or unlock paid collections in the Store.", availableCount: accessibleBankQuestions, locked: accessibleBanks.length === 0 },
      { id: "WRONG_ANSWERS" as const, title: "Wrong Answers", description: "Revisit authorized questions you previously missed.", availableCount: wrong, locked: wrong === 0 },
      { id: "REVISIT" as const, title: "Revisit", description: "Revise questions you have answered correctly at least once.", availableCount: revisit, locked: revisit === 0 },
    ],
  };
}

function modeQuestionWhere(mode: PracticeMode): Prisma.QuestionWhereInput {
  if (mode === "CASE_STUDY") return { kind: "CASE_MCQ", practiceCollection: { not: "QUESTION_BANK" } };
  if (mode === "QUESTION_BANK") return { kind: { in: ["NORMAL_MCQ", "CASE_MCQ"] }, practiceCollection: "QUESTION_BANK" };
  if (isReviewMode(mode)) return { kind: { in: ["NORMAL_MCQ", "CASE_MCQ"] } };
  return { kind: "NORMAL_MCQ", practiceCollection: { not: "QUESTION_BANK" } };
}

export async function searchPracticeScope(userId: string, input: { mode: PracticeMode; questionBankId?: string; query?: string; limit: number }) {
  const course = await selectedCourse(userId);
  if (input.mode === "QUESTION_BANK") {
    if (!input.questionBankId) return { course: { id: course.id, code: course.code, name: course.name }, mode: input.mode, materials: [], topics: [] };
    const visibleBanks = await listQuestionBanks(userId);
    const visibleBank = visibleBanks.find((bank) => bank.id === input.questionBankId);
    if (!visibleBank) throw forbidden("QUESTION_BANK_NOT_AVAILABLE", "This Question Bank is not available to your account.");
    if (visibleBank.locked) throw forbidden("QUESTION_BANK_PURCHASE_REQUIRED", "Purchase this Question Bank in the Store before starting practice.");
  } else if (input.questionBankId) {
    throw badRequest("QUESTION_BANK_NOT_ALLOWED", "questionBankId is only valid in Question Bank mode.");
  }
  const accessible = [...await accessibleContentIdsForCourse(userId, course.id)];
  const eligible = accessible;
  const history = isReviewMode(input.mode) || input.mode === "MCQ" ? await practiceHistoryPairs(userId, course.id) : null;
  const historyPairs = input.mode === "REVISIT" ? history?.correct : input.mode === "WRONG_ANSWERS" ? history?.wrong : undefined;
  const historyIds = historyPairs ? parentIdsForPairs(historyPairs) : undefined;
  const excludedIds = input.mode === "MCQ" && history ? normalMcqQuestionIds(history.attemptedNormal) : undefined;
  const questionBase: Prisma.QuestionWhereInput = {
    courseId: course.id, academyId: course.academyId, status: "PUBLISHED", deletedAt: null,
    ...modeQuestionWhere(input.mode), ...(historyIds ? { id: { in: historyIds } } : {}),
    ...(excludedIds?.length ? { NOT: { id: { in: excludedIds } } } : {}),
    ...(input.questionBankId ? { questionBankId: input.questionBankId } : {}),
    ...(input.mode === "QUESTION_BANK" ? {} : isReviewMode(input.mode) ? authorizedQuestionAccess(userId, eligible) : { contentLinks: { some: { contentItemId: { in: eligible } } } }),
  };
  const query = input.query?.trim();
  const files = await prisma.contentItem.findMany({
    where: {
      ...(input.mode === "QUESTION_BANK" ? {} : { id: { in: eligible } }), courseId: course.id, kind: "FILE", status: "PUBLISHED", deletedAt: null,
      questionLinks: { some: { question: questionBase } },
      ...(query ? { OR: [{ name: { contains: query, mode: "insensitive" } }, { description: { contains: query, mode: "insensitive" } }] } : {}),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }], take: input.limit,
    select: { id: true, name: true, description: true, mimeType: true, accessType: true, parent: { select: { id: true, name: true } }, _count: { select: { questionLinks: { where: { question: questionBase } } } } },
  });
  const topics = await prisma.taxonomyTopic.findMany({
    where: { lesson: { chapter: { courseId: course.id } }, questions: { some: questionBase }, ...(query ? { name: { contains: query, mode: "insensitive" } } : {}) },
    orderBy: { name: "asc" }, take: input.limit,
    select: { id: true, name: true, lesson: { select: { chapter: { select: { id: true, name: true, subject: { select: { id: true, name: true } } } } } }, _count: { select: { questions: { where: questionBase } } } },
  });
  return {
    course: { id: course.id, code: course.code, name: course.name }, mode: input.mode,
    materials: files.map((file) => ({ id: file.id, kind: "MATERIAL" as const, title: file.name, subtitle: file.parent?.name ?? course.name, description: file.description, accessType: file.accessType, questionCount: file._count.questionLinks })),
    topics: topics.map((topic) => ({ id: topic.id, kind: "TOPIC" as const, title: topic.name, subtitle: `${topic.lesson.chapter.subject.name} · ${topic.lesson.chapter.name}`, questionCount: topic._count.questions })),
  };
}

export async function listQuestionBanks(userId: string) {
  const course = await selectedCourse(userId);
  const banks = await prisma.questionBank.findMany({
    where: { courseId: course.id, academyId: course.academyId, status: "PUBLISHED", deletedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: {
      questions: {
        where: { status: "PUBLISHED", deletedAt: null },
        select: { id: true, kind: true, contentLinks: { select: { contentItemId: true } } },
      },
    },
  });
  const paidBankIds = banks.filter((bank) => bank.accessType === "PAID").map((bank) => bank.id);
  const entitledBanks = await questionBankAccess(userId, paidBankIds);
  return banks.flatMap((bank) => {
    const paidAccess = entitledBanks.get(bank.id) ?? null;
    const owned = bank.accessType === "FREE" || Boolean(paidAccess);
    const accessibleQuestions = bank.questions;
    if (!accessibleQuestions.length) return [];
    const accessibleMaterialIds = owned
      ? [...new Set(accessibleQuestions.flatMap((question) => question.contentLinks.map((link) => link.contentItemId)))]
      : [];
    return [{
      id: bank.id,
      slug: bank.slug,
      title: bank.name,
      description: bank.description,
      questionKinds: [...new Set(accessibleQuestions.map((question) => question.kind))],
      accessType: bank.accessType,
      price: Number(bank.price),
      accessDurationValue: bank.accessDurationValue,
      accessDurationUnit: bank.accessDurationUnit,
      owned,
      locked: !owned,
      purchaseRequired: !owned,
      storePath: `/store/product/${encodeURIComponent(bank.slug)}`,
      accessSource: bank.accessType === "FREE" ? "FREE" : paidAccess?.source ?? null,
      includedInPackage: paidAccess?.source === "PACKAGE",
      includedPackage: paidAccess?.source === "PACKAGE" ? { id: paidAccess.packageId!, title: paidAccess.packageTitle! } : null,
      materialIds: accessibleMaterialIds,
      questionCount: accessibleQuestions.length,
    }];
  });
}

export async function getPracticeFilters(userId: string, input: SourceInput) {
  const source = await validateSource(userId, input);
  const mode = input.mode ?? "MCQ";
  if (mode === "QUESTION_BANK") {
    if (!input.questionBankId) throw badRequest("QUESTION_BANK_REQUIRED", "Choose a Question Bank before loading its filters.");
    const visibleBank = (await listQuestionBanks(userId)).find((bank) => bank.id === input.questionBankId);
    if (!visibleBank) throw forbidden("QUESTION_BANK_NOT_AVAILABLE", "This Question Bank is not available to your account.");
    if (visibleBank.locked) throw forbidden("QUESTION_BANK_PURCHASE_REQUIRED", "Purchase this Question Bank in the Store before loading its filters.");
  } else if (input.questionBankId) {
    throw badRequest("QUESTION_BANK_NOT_ALLOWED", "questionBankId is only valid in Question Bank mode.");
  }
  const accessibleContentIds = [...await accessibleContentIdsForCourse(userId, source.course.id)];
  const eligibleContentIds = accessibleContentIds;
  const history = isReviewMode(mode) || mode === "MCQ" ? await practiceHistoryPairs(userId, source.course.id) : null;
  const historyPairs = mode === "REVISIT" ? history?.correct : mode === "WRONG_ANSWERS" ? history?.wrong : undefined;
  const historyIds = historyPairs ? parentIdsForPairs(historyPairs) : undefined;
  const excludedIds = mode === "MCQ" && history ? normalMcqQuestionIds(history.attemptedNormal) : undefined;
  const base: Prisma.QuestionWhereInput = { courseId: source.course.id, academyId: source.course.academyId, status: "PUBLISHED", deletedAt: null, ...modeQuestionWhere(mode), ...(input.questionBankId ? { questionBankId: input.questionBankId } : {}), ...(historyIds ? { id: { in: historyIds } } : {}), ...(excludedIds?.length ? { NOT: { id: { in: excludedIds } } } : {}), ...(mode === "QUESTION_BANK" ? {} : isReviewMode(mode) ? authorizedQuestionAccess(userId, eligibleContentIds) : { contentLinks: { some: { contentItemId: { in: eligibleContentIds } } } }) };
  const [subjects, linkedFiles, collections, years] = await Promise.all([
    prisma.subject.findMany({ where: { courseId: source.course.id, deletedAt: null, questions: { some: base } }, orderBy: { name: "asc" }, select: { id: true, name: true, taxonomyChapters: { where: { questions: { some: base } }, orderBy: { name: "asc" }, select: { id: true, name: true, lessons: { orderBy: { name: "asc" }, select: { id: true, name: true, topics: { orderBy: { name: "asc" }, select: { id: true, name: true } } } } } } } }),
    prisma.contentItem.findMany({ where: { ...(mode === "QUESTION_BANK" ? {} : { id: { in: eligibleContentIds } }), courseId: source.course.id, kind: "FILE", status: "PUBLISHED", deletedAt: null, questionLinks: { some: { question: base } } }, orderBy: { name: "asc" }, select: { id: true, name: true, mimeType: true, accessType: true } }),
    prisma.question.findMany({ where: base, distinct: ["practiceCollection"], select: { practiceCollection: true }, take: 10 }),
    prisma.question.findMany({ where: { ...base, practiceYear: { not: null } }, distinct: ["practiceYear"], orderBy: { practiceYear: "desc" }, select: { practiceYear: true }, take: 100 }),
  ]);
  return { sourceKind: input.sourceKind, mode, questionBankId: input.questionBankId ?? null, accessPolicy: source.policy, linkedFiles, subjects, collections: collections.map((item) => item.practiceCollection), years: years.flatMap((item) => item.practiceYear === null ? [] : [item.practiceYear]), capabilities: { yearFilter: mode === "MCQ", retryWrong: source.policy === "PAID", explanationAfterWrong: true } };
}

async function candidates(userId: string, input: FilterInput) {
  validateFilterRules(input);
  const source = await validateSource(userId, input);
  const accessibleContentIds = [...await accessibleContentIdsForCourse(userId, source.course.id)];
  let eligibleContentIds = accessibleContentIds;
  const mode = input.mode ?? (input.answerFormat === "CASE_STUDY" ? "CASE_STUDY" : "MCQ");
  const selectedIds = [...new Set(input.contentItemIds ?? [])];
  if (mode !== "QUESTION_BANK" && selectedIds.some((id) => !accessibleContentIds.includes(id))) throw forbidden("PRACTICE_MATERIAL_FORBIDDEN", "One or more selected materials are not available to this learner.");
  if (selectedIds.length) {
    const valid = await prisma.contentItem.count({ where: { id: { in: selectedIds }, courseId: source.course.id, kind: "FILE", status: "PUBLISHED", deletedAt: null } });
    if (valid !== selectedIds.length) throw badRequest("INVALID_PRACTICE_MATERIALS", "Every selected material must be a published file in the learner's selected course.");
  }
  const history = await practiceHistoryPairs(userId, source.course.id);
  const statePairs = mode === "REVISIT" ? history.correct : mode === "WRONG_ANSWERS" ? history.wrong : null;
  const historyQuestionIds = statePairs ? parentIdsForPairs(statePairs) : undefined;
  const excludedQuestionIds = mode === "MCQ" ? normalMcqQuestionIds(history.attemptedNormal) : undefined;
  if (mode === "QUESTION_BANK") {
    const bank = await prisma.questionBank.findFirst({
      where: { id: input.questionBankId!, courseId: source.course.id, academyId: source.course.academyId, status: "PUBLISHED", deletedAt: null },
      select: { id: true, accessType: true },
    });
    if (!bank) throw notFound("QUESTION_BANK_NOT_FOUND", "The selected Question Bank is not available for this course.");
    if (bank.accessType === "PAID") {
      const entitled = await questionBankAccess(userId, [bank.id]);
      if (!entitled.has(bank.id)) throw forbidden("QUESTION_BANK_PURCHASE_REQUIRED", "Purchase this Question Bank or a package containing it on the website before starting practice.");
      source.policy = "PAID";
    }
    const bankFiles = await prisma.contentItem.findMany({
      where: { courseId: source.course.id, kind: "FILE", status: "PUBLISHED", deletedAt: null, questionLinks: { some: { question: { questionBankId: bank.id, status: "PUBLISHED", deletedAt: null } } } },
      select: { id: true },
    });
    const bankFileIds = bankFiles.map((item) => item.id);
    if (selectedIds.some((id) => !bankFileIds.includes(id))) throw forbidden("QUESTION_BANK_MATERIAL_FORBIDDEN", "One or more selected files are not part of this Question Bank.");
    eligibleContentIds = bankFileIds;
  }
  const questions = await prisma.question.findMany({
    where: questionWhere(userId, source.course.id, source.course.academyId, input, eligibleContentIds, historyQuestionIds, excludedQuestionIds),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true, kind: true, difficulty: true, questionHtml: true, caseHtml: true, answerHtml: true, correctOptionId: true, correctExplanationHtml: true, premiumWrongOptionsExplanationHtml: true, subjectId: true, chapterId: true, lessonId: true, topicId: true, examName: true, chapterName: true, conceptName: true,
      options: { orderBy: { displayOrder: "asc" }, select: { optionLabel: true, html: true, displayOrder: true } },
      subQuestions: { orderBy: { displayOrder: "asc" }, select: { id: true, questionHtml: true, answerHtml: true, correctOptionId: true, correctExplanationHtml: true, premiumWrongOptionsExplanationHtml: true, subjectId: true, chapterId: true, lessonId: true, topicId: true, examName: true, chapterName: true, conceptName: true, options: { orderBy: { displayOrder: "asc" }, select: { optionLabel: true, html: true, displayOrder: true } } } },
    },
  });
  const expanded: PracticeCandidate[] = [];
  for (const question of questions) {
    if (question.kind.startsWith("CASE_")) {
      for (const sub of question.subQuestions) expanded.push({ questionId: question.id, subQuestionId: sub.id, kind: question.kind, difficulty: question.difficulty, promptHtml: sub.questionHtml, caseHtml: question.caseHtml, options: sub.options, correctOptionLabel: sub.correctOptionId, answerHtml: sub.answerHtml, correctExplanationHtml: sub.correctExplanationHtml, premiumWrongExplanationHtml: sub.premiumWrongOptionsExplanationHtml, subjectId: sub.subjectId ?? question.subjectId, chapterId: sub.chapterId ?? question.chapterId, lessonId: sub.lessonId ?? question.lessonId, topicId: sub.topicId ?? question.topicId, examName: sub.examName || question.examName, chapterName: sub.chapterName || question.chapterName, conceptName: sub.conceptName || question.conceptName });
    } else {
      expanded.push({ questionId: question.id, subQuestionId: null, kind: question.kind, difficulty: question.difficulty, promptHtml: question.questionHtml, caseHtml: "", options: question.options, correctOptionLabel: question.correctOptionId, answerHtml: question.answerHtml, correctExplanationHtml: question.correctExplanationHtml, premiumWrongExplanationHtml: question.premiumWrongOptionsExplanationHtml, subjectId: question.subjectId, chapterId: question.chapterId, lessonId: question.lessonId, topicId: question.topicId, examName: question.examName, chapterName: question.chapterName, conceptName: question.conceptName });
    }
  }
  if (statePairs) return { source, expanded: expanded.filter((item) => statePairs.has(pairKey(item.questionId, item.subQuestionId))) };
  if (mode === "MCQ" || mode === "CASE_STUDY") return { source, expanded: expanded.filter((item) => !history.attemptedNormal.has(pairKey(item.questionId, item.subQuestionId))) };
  return { source, expanded };
}

export async function previewPracticeSet(userId: string, input: FilterInput) {
  const result = await candidates(userId, input);
  const eligible = result.expanded.length;
  if (!eligible) throw notFound("FILTER_COMBINATION_EMPTY", "No published questions match these filters.");
  return { eligibleQuestionCount: eligible, selectedQuestionCount: input.questionCount === undefined ? eligible : Math.min(input.questionCount, eligible), unlimitedQuestions: input.questionCount === undefined, timerSeconds: input.timerSeconds ?? null, accessPolicy: result.source.policy, normalized: input };
}

export async function createPracticeSession(userId: string, input: FilterInput) {
  const result = await candidates(userId, input);
  if (!result.expanded.length) throw notFound("FILTER_COMBINATION_EMPTY", "No published questions match these filters.");
  if (input.questionCount !== undefined && input.questionCount > result.expanded.length) throw badRequest("INSUFFICIENT_QUESTIONS", `Only ${result.expanded.length} question${result.expanded.length === 1 ? " is" : "s are"} available for this selection.`);
  const selected = input.questionCount === undefined ? result.expanded : result.expanded.slice(0, input.questionCount);
  const now = new Date();
  const expiresAt = input.timerSeconds ? new Date(now.getTime() + input.timerSeconds * 1000) : null;
  return prisma.practiceSession.create({
    data: {
      userId, courseId: result.source.course.id, sourceKind: "ARCHIVE", mode: input.mode ?? (input.answerFormat === "CASE_STUDY" ? "CASE_STUDY" : "MCQ"), subjectId: input.subjectId, chapterId: input.chapterId, lessonId: input.lessonId, topicId: input.topicId, collection: input.collection, questionBankId: input.questionBankId, year: input.year, answerFormat: input.answerFormat, accessPolicy: result.source.policy, timerSeconds: input.timerSeconds, questionCount: selected.length, unlimitedQuestions: input.questionCount === undefined, expiresAt,
      materials: input.contentItemIds?.length ? { create: [...new Set(input.contentItemIds)].map((contentItemId) => ({ contentItemId })) } : undefined,
      questions: { create: selected.map((question, index) => ({ questionId: question.questionId, subQuestionId: question.subQuestionId, sequence: index + 1, kind: question.kind, difficulty: question.difficulty, promptHtml: question.promptHtml, caseHtml: question.caseHtml, optionsSnapshot: question.options as Prisma.InputJsonValue, correctOptionLabel: question.correctOptionLabel, answerHtml: question.answerHtml, correctExplanationHtml: question.correctExplanationHtml, premiumWrongExplanationHtml: question.premiumWrongExplanationHtml, subjectId: question.subjectId, chapterId: question.chapterId, lessonId: question.lessonId, topicId: question.topicId, examName: question.examName, chapterName: question.chapterName, conceptName: question.conceptName })) },
    },
    select: { id: true, sourceKind: true, mode: true, questionBankId: true, answerFormat: true, accessPolicy: true, questionCount: true, unlimitedQuestions: true, timerSeconds: true, startedAt: true, expiresAt: true, status: true },
  });
}

async function ownedSession(userId: string, sessionId: string) {
  const session = await prisma.practiceSession.findFirst({ where: { id: sessionId, userId }, select: { id: true, userId: true, courseId: true, sourceKind: true, mode: true, questionBankId: true, answerFormat: true, accessPolicy: true, timerSeconds: true, questionCount: true, unlimitedQuestions: true, answeredCount: true, correctCount: true, wrongCount: true, markedReviewCount: true, status: true, startedAt: true, expiresAt: true, completedAt: true, materials: { select: { contentItem: { select: { id: true, name: true } } } } } });
  if (!session) throw notFound("PRACTICE_SESSION_NOT_FOUND", "The practice session was not found.");
  if (session.status === "ACTIVE" && session.expiresAt && session.expiresAt <= new Date()) {
    await prisma.practiceSession.updateMany({ where: { id: session.id, status: "ACTIVE" }, data: { status: "EXPIRED", completedAt: new Date() } });
    return { ...session, status: "EXPIRED" as const };
  }
  return session;
}

function prompt(question: { id: string; sequence: number; kind: QuestionKind; difficulty: string; promptHtml: string; caseHtml: string; optionsSnapshot: Prisma.JsonValue; navigatorState: string; attemptCount: number; final: boolean; examName: string; chapterName: string }) {
  return { id: question.id, sequence: question.sequence, kind: question.kind, difficulty: question.difficulty, promptHtml: question.promptHtml, caseHtml: question.caseHtml || null, options: question.optionsSnapshot, navigatorState: question.navigatorState, attemptCount: question.attemptCount, final: question.final, examName: question.examName, chapterName: question.chapterName };
}

export async function getPracticeSession(userId: string, sessionId: string) {
  const session = await ownedSession(userId, sessionId);
  const questions = await prisma.practiceSessionQuestion.findMany({ where: { sessionId }, orderBy: { sequence: "asc" }, select: { id: true, sequence: true, navigatorState: true, attemptCount: true, final: true } });
  return { ...session, navigator: questions };
}

export async function getResumablePracticeSession(userId: string) {
  const course = await selectedCourse(userId);
  const session = await prisma.practiceSession.findFirst({ where: { userId, courseId: course.id, status: "ACTIVE" }, orderBy: { startedAt: "desc" }, select: { id: true } });
  return session ? getPracticeSession(userId, session.id) : null;
}

export async function getPracticeResult(userId: string, sessionId: string) {
  const session = await ownedSession(userId, sessionId);
  const attempts = await prisma.practiceAttempt.findMany({ where: { userId, sessionQuestion: { sessionId } }, orderBy: { createdAt: "asc" }, select: { correct: true, durationMs: true } });
  const evaluated = attempts.filter((attempt) => attempt.correct !== null);
  return {
    session,
    score: { correct: session.correctCount, wrong: session.wrongCount, answered: session.answeredCount, total: session.questionCount, percent: session.questionCount ? Math.round(session.correctCount / session.questionCount * 100) : 0 },
    durationMs: attempts.reduce((sum, attempt) => sum + (attempt.durationMs ?? 0), 0),
    accuracyPercent: evaluated.length ? Math.round(evaluated.filter((attempt) => attempt.correct).length / evaluated.length * 100) : null,
  };
}

export async function listWrongAnswers(userId: string, input: { page: number; limit: number }) {
  const course = await selectedCourse(userId);
  const accessible = [...await accessibleContentIdsForCourse(userId, course.id)];
  const history = await practiceHistoryPairs(userId, course.id);
  const rows = await prisma.practiceSessionQuestion.findMany({
    where: { session: { userId, courseId: course.id }, questionId: { in: parentIdsForPairs(history.wrong) }, attempts: { some: { userId, correct: false } }, question: { status: "PUBLISHED", deletedAt: null, ...authorizedQuestionAccess(userId, accessible) } },
    distinct: ["questionId", "subQuestionId"], orderBy: { lastAttemptAt: "desc" },
    select: { id: true, questionId: true, subQuestionId: true, promptHtml: true, caseHtml: true, difficulty: true, lastAttemptAt: true, subjectId: true, chapterId: true, topicId: true, attempts: { where: { userId, correct: false }, orderBy: { createdAt: "desc" }, take: 1, select: { answerOptionLabel: true, createdAt: true } } },
  });
  const current = rows.filter((row) => history.wrong.has(pairKey(row.questionId, row.subQuestionId)));
  const offset = (input.page - 1) * input.limit;
  const page = current.slice(offset, offset + input.limit);
  return { data: page.map((row) => ({ ...row, lastWrongAttempt: row.attempts[0] ?? null })), pagination: { page: input.page, limit: input.limit, hasMore: current.length > offset + input.limit } };
}

export async function listSessionQuestions(userId: string, sessionId: string, page: number, limit: number) {
  const session = await ownedSession(userId, sessionId);
  const [questions, total] = await Promise.all([
    prisma.practiceSessionQuestion.findMany({ where: { sessionId }, skip: (page - 1) * limit, take: limit, orderBy: { sequence: "asc" }, select: { id: true, sequence: true, kind: true, difficulty: true, promptHtml: true, caseHtml: true, optionsSnapshot: true, navigatorState: true, attemptCount: true, final: true, examName: true, chapterName: true } }),
    prisma.practiceSessionQuestion.count({ where: { sessionId } }),
  ]);
  return { session: { id: session.id, status: session.status, accessPolicy: session.accessPolicy, expiresAt: session.expiresAt }, items: questions.map(prompt), pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}

function releasedExplanation(question: { answerHtml: string; correctExplanationHtml: string; premiumWrongExplanationHtml: string }, correct: boolean | null) {
  if (correct === false) return question.premiumWrongExplanationHtml || question.correctExplanationHtml || question.answerHtml || null;
  return question.correctExplanationHtml || question.answerHtml || null;
}

function releasedExplanations(question: { answerHtml: string; correctExplanationHtml: string; premiumWrongExplanationHtml: string }) {
  return {
    correctExplanation: question.correctExplanationHtml || question.answerHtml || null,
    wrongExplanation: question.premiumWrongExplanationHtml || null,
  };
}

async function refreshSessionCounters(tx: Prisma.TransactionClient, sessionId: string) {
  const questions = await tx.practiceSessionQuestion.findMany({ where: { sessionId }, select: { navigatorState: true, attemptCount: true, final: true } });
  const answeredCount = questions.filter((item) => item.attemptCount > 0).length;
  const correctCount = questions.filter((item) => item.navigatorState === "ANSWERED_CORRECT").length;
  const wrongCount = questions.filter((item) => item.navigatorState === "ANSWERED_WRONG" || item.navigatorState === "LOCKED_WRONG").length;
  const markedReviewCount = questions.filter((item) => item.navigatorState === "MARKED_REVIEW").length;
  const allFinal = questions.length > 0 && questions.every((item) => item.final);
  return tx.practiceSession.update({ where: { id: sessionId }, data: { answeredCount, correctCount, wrongCount, markedReviewCount, ...(allFinal ? { status: "COMPLETED", completedAt: new Date() } : {}) }, select: { id: true, status: true, answeredCount: true, correctCount: true, wrongCount: true, markedReviewCount: true, completedAt: true } });
}

export async function submitAttempt(userId: string, sessionId: string, sessionQuestionId: string, input: { clientAttemptId: string; answerOptionLabel?: string; answerText?: string; durationMs?: number }) {
  const session = await ownedSession(userId, sessionId);
  const existing = await prisma.practiceAttempt.findFirst({ where: { sessionQuestionId, clientAttemptId: input.clientAttemptId, userId, sessionQuestion: { sessionId } }, include: { sessionQuestion: true } });
  if (existing) return { attempt: { id: existing.id, attemptNumber: existing.attemptNumber, correct: existing.correct, createdAt: existing.createdAt }, result: { navigatorState: existing.sessionQuestion.navigatorState, retryAllowed: !existing.sessionQuestion.final, correctOptionLabel: existing.sessionQuestion.correctOptionLabel, explanation: releasedExplanation(existing.sessionQuestion, existing.correct), ...releasedExplanations(existing.sessionQuestion) }, replay: true };
  if (session.status !== "ACTIVE") {
    const locked = await prisma.practiceSessionQuestion.findFirst({ where: { id: sessionQuestionId, sessionId, navigatorState: "LOCKED_WRONG" }, select: { id: true } });
    if (locked) throw forbidden("WRONG_RETRY_PAID_REQUIRED", "Free Archive questions cannot be retried after an incorrect answer.");
    throw conflict(session.status === "EXPIRED" ? "SESSION_EXPIRED" : "SESSION_NOT_ACTIVE", "This practice session no longer accepts answers.");
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const question = await tx.practiceSessionQuestion.findFirst({ where: { id: sessionQuestionId, sessionId }, include: { session: { select: { accessPolicy: true, status: true } } } });
      if (!question) throw notFound("SESSION_QUESTION_NOT_FOUND", "The practice question was not found in this session.");
      if (question.final) {
        if (question.navigatorState === "LOCKED_WRONG") throw forbidden("WRONG_RETRY_PAID_REQUIRED", "Free Archive questions cannot be retried after an incorrect answer.");
        throw conflict("ANSWER_ALREADY_FINAL", "This question already has a final answer.");
      }
      const isMcq = question.kind === "NORMAL_MCQ" || question.kind === "CASE_MCQ";
      const option = input.answerOptionLabel?.trim().toUpperCase();
      const text = input.answerText?.trim();
      if (isMcq && (!option || !/^[A-Z]$/.test(option))) throw badRequest("ANSWER_OPTION_REQUIRED", "Choose one answer option.");
      if (!isMcq && !text) throw badRequest("ANSWER_TEXT_REQUIRED", "Enter an answer before submitting.");
      const correct = isMcq ? option === question.correctOptionLabel : null;
      const paid = question.session.accessPolicy === "PAID";
      const explanationReleased = true;
      const final = correct === true || correct === null || !paid;
      const navigatorState = correct === true ? "ANSWERED_CORRECT" as const : correct === null ? "AWAITING_REVIEW" as const : paid ? "ANSWERED_WRONG" as const : "LOCKED_WRONG" as const;
      const attemptNumber = question.attemptCount + 1;
      const attempt = await tx.practiceAttempt.create({ data: { userId, sessionQuestionId, attemptNumber, clientAttemptId: input.clientAttemptId, answerOptionLabel: option, answerText: text, correct, durationMs: input.durationMs, explanationReleased }, select: { id: true, attemptNumber: true, correct: true, createdAt: true } });
      const updated = await tx.practiceSessionQuestion.update({ where: { id: question.id }, data: { attemptCount: attemptNumber, navigatorState, final, lastAttemptAt: new Date() } });
      const summary = await refreshSessionCounters(tx, sessionId);
      return { attempt, result: { navigatorState: updated.navigatorState, retryAllowed: !updated.final, correctOptionLabel: question.correctOptionLabel, explanation: releasedExplanation(question, correct), ...releasedExplanations(question) }, session: summary, replay: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const replay = await prisma.practiceAttempt.findFirst({ where: { sessionQuestionId, clientAttemptId: input.clientAttemptId, userId }, include: { sessionQuestion: true } });
      if (replay) return { attempt: { id: replay.id, attemptNumber: replay.attemptNumber, correct: replay.correct, createdAt: replay.createdAt }, result: { navigatorState: replay.sessionQuestion.navigatorState, retryAllowed: !replay.sessionQuestion.final, correctOptionLabel: replay.sessionQuestion.correctOptionLabel, explanation: releasedExplanation(replay.sessionQuestion, replay.correct), ...releasedExplanations(replay.sessionQuestion) }, replay: true };
    }
    throw error;
  }
}

export async function setMarkedForReview(userId: string, sessionId: string, sessionQuestionId: string, marked: boolean) {
  const session = await ownedSession(userId, sessionId);
  if (session.status !== "ACTIVE") throw conflict("SESSION_NOT_ACTIVE", "This practice session is no longer active.");
  return prisma.$transaction(async (tx) => {
    const question = await tx.practiceSessionQuestion.findFirst({ where: { id: sessionQuestionId, sessionId } });
    if (!question) throw notFound("SESSION_QUESTION_NOT_FOUND", "The practice question was not found in this session.");
    if (question.final || question.attemptCount > 0) throw conflict("ANSWER_STATE_FINAL", "Answered questions cannot be changed to review-only state.");
    const updated = await tx.practiceSessionQuestion.update({ where: { id: question.id }, data: { navigatorState: marked ? "MARKED_REVIEW" : "UNANSWERED" }, select: { id: true, sequence: true, navigatorState: true } });
    await refreshSessionCounters(tx, sessionId);
    return updated;
  });
}

export async function completePracticeSession(userId: string, sessionId: string) {
  const session = await ownedSession(userId, sessionId);
  if (session.status === "EXPIRED") throw conflict("SESSION_EXPIRED", "This practice timer has expired.");
  if (session.status === "COMPLETED") return getPracticeResult(userId, sessionId);
  await prisma.practiceSession.update({ where: { id: session.id }, data: { status: "COMPLETED", completedAt: new Date() } });
  const completionTimingReport = session.timerSeconds === null ? await prisma.practiceSessionQuestion.findMany({
    where: { sessionId: session.id, attempts: { some: { userId, durationMs: { not: null } } } },
    orderBy: { sequence: "asc" },
    select: { id: true, sequence: true, attempts: { where: { userId, durationMs: { not: null } }, select: { durationMs: true } } },
  }).then((questions) => questions.map((question) => ({
    questionId: question.id,
    sequence: question.sequence,
    durationMs: question.attempts.reduce((total, attempt) => total + (attempt.durationMs ?? 0), 0),
  }))) : null;
  void generateStudyPlan(userId, undefined, true).catch((error) => {
    // Practice completion is authoritative. A derived plan can be regenerated on
    // the learner's next study-plan request, so it must not roll back the session.
    logger.error("practice.study_plan_refresh_failed", error, { userId, sessionId });
  });
  const completed = await getPracticeResult(userId, sessionId);
  return completionTimingReport ? { ...completed, completionTimingReport } : completed;
}

export async function getPracticeTracker(userId: string) {
  const course = await selectedCourse(userId);
  const paid = await hasPaidPracticePolicy(userId);
  const timezone = (await prisma.learnerPreference.findUnique({ where: { userId }, select: { timezone: true } }))?.timezone ?? "Asia/Kolkata";
  const rows = await prisma.practiceSessionQuestion.findMany({
    where: { session: { userId, courseId: course.id }, attemptCount: { gt: 0 } },
    take: 10_000,
    select: { id: true, questionId: true, subjectId: true, chapterId: true, topicId: true, navigatorState: true, attemptCount: true, attempts: { select: { correct: true, durationMs: true, createdAt: true } } },
  });
  const subjectIds = [...new Set(rows.flatMap((row) => row.subjectId ? [row.subjectId] : []))];
  const chapterIds = [...new Set(rows.flatMap((row) => row.chapterId ? [row.chapterId] : []))];
  const topicIds = [...new Set(rows.flatMap((row) => row.topicId ? [row.topicId] : []))];
  const [subjects, chapters, topics] = await Promise.all([
    prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } }),
    prisma.taxonomyChapter.findMany({ where: { id: { in: chapterIds } }, select: { id: true, name: true, subject: { select: { id: true, name: true } } } }),
    prisma.taxonomyTopic.findMany({ where: { id: { in: topicIds } }, select: { id: true, name: true, lesson: { select: { chapter: { select: { id: true, name: true, subject: { select: { id: true, name: true } } } } } } } }),
  ]);
  const subjectMap = new Map(subjects.map((subject) => [subject.id, subject]));
  const chapterMap = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const topicMap = new Map(topics.map((topic) => [topic.id, topic]));
  type Metrics = { questionIds: Set<string>; attempts: number; correct: number; wrong: number; durationMs: number };
  const emptyMetrics = (): Metrics => ({ questionIds: new Set(), attempts: 0, correct: 0, wrong: 0, durationMs: 0 });
  const subjectTotals = new Map<string, Metrics>();
  const chapterTotals = new Map<string, Metrics>();
  const topicTotals = new Map<string, Metrics>();
  const dailyTotals = new Map<string, { attempts: number; correct: number; wrong: number; durationMs: number }>();
  const add = (map: Map<string, Metrics>, id: string, row: typeof rows[number]) => {
    const current = map.get(id) ?? emptyMetrics();
    current.questionIds.add(row.questionId);
    current.attempts += row.attempts.length;
    current.correct += row.attempts.filter((attempt) => attempt.correct === true).length;
    current.wrong += row.attempts.filter((attempt) => attempt.correct === false).length;
    current.durationMs += row.attempts.reduce((sum, attempt) => sum + (attempt.durationMs ?? 0), 0);
    map.set(id, current);
  };
  for (const row of rows) {
    if (row.subjectId) add(subjectTotals, row.subjectId, row);
    if (row.chapterId) add(chapterTotals, row.chapterId, row);
    if (row.topicId) add(topicTotals, row.topicId, row);
    for (const attempt of row.attempts) {
      const date = learnerDateKey(attempt.createdAt, timezone);
      const day = dailyTotals.get(date) ?? { attempts: 0, correct: 0, wrong: 0, durationMs: 0 };
      day.attempts += 1;
      day.correct += attempt.correct === true ? 1 : 0;
      day.wrong += attempt.correct === false ? 1 : 0;
      day.durationMs += attempt.durationMs ?? 0;
      dailyTotals.set(date, day);
    }
  }
  const metric = (value: Metrics) => ({ questionsSolved: value.questionIds.size, attempts: value.attempts, correct: value.correct, wrong: value.wrong, durationMs: value.durationMs, accuracyPercent: value.correct + value.wrong ? Math.round(value.correct / (value.correct + value.wrong) * 100) : null });
  const subjectMetrics = [...subjectTotals].flatMap(([id, value]) => subjectMap.has(id) ? [{ subjectId: id, subjectName: subjectMap.get(id)!.name, ...metric(value) }] : []);
  const chapterMetrics = [...chapterTotals].flatMap(([id, value]) => chapterMap.has(id) ? [{ chapterId: id, chapterName: chapterMap.get(id)!.name, subject: chapterMap.get(id)!.subject, ...metric(value) }] : []);
  const topicMetrics = [...topicTotals].flatMap(([id, value]) => topicMap.has(id) ? [{ topicId: id, topicName: topicMap.get(id)!.name, chapter: { id: topicMap.get(id)!.lesson.chapter.id, name: topicMap.get(id)!.lesson.chapter.name }, subject: topicMap.get(id)!.lesson.chapter.subject, ...metric(value) }] : []);
  const uniqueQuestions = new Set(rows.map((row) => row.questionId)).size;
  const attempts = rows.flatMap((row) => row.attempts);
  const weakAreas = paid ? topicMetrics.filter((item) => item.wrong >= 2 && (item.accuracyPercent ?? 100) < 60).sort((a, b) => (a.accuracyPercent ?? 100) - (b.accuracyPercent ?? 100) || b.wrong - a.wrong) : null;
  return {
    course: { id: course.id, code: course.code, name: course.name },
    totals: { questionsSolved: uniqueQuestions, attempts: attempts.length, correct: attempts.filter((attempt) => attempt.correct === true).length, wrong: attempts.filter((attempt) => attempt.correct === false).length, durationMs: attempts.reduce((sum, attempt) => sum + (attempt.durationMs ?? 0), 0) },
    subjects: subjectMetrics,
    chapters: chapterMetrics,
    topics: topicMetrics,
    activity: [...dailyTotals].sort(([left], [right]) => left.localeCompare(right)).slice(-30).map(([date, value]) => ({ date, ...value })),
    weakAreas,
    capabilities: { conceptWeakAreas: paid, weakAreaGranularity: "TOPIC" as const },
  };
}
