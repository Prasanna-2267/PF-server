import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { prisma } from "../db/prisma.js";
import { badRequest, conflict, notFound } from "../errors/api-error.js";
import { sanitizeRichText } from "../utils/sanitize-html.js";
import { assertQuestionBankForWrite } from "./questionBankService.js";
import { createQuestionsAtomically, type QuestionInput, type QuestionScope } from "./questionService.js";

type ImportMode = "normal" | "case";
type ImportRequest = { courseId: string; mode: ImportMode; practiceCollection?: "ORIGINAL" | "QUESTION_BANK"; questionBankId?: string; fileName: string; contentBase64: string };
type ValidationError = { row: number; field: string; problem: string };

const NORMAL_HEADERS = ["Question", "Option A", "Option B", "Option C", "Option D", "Correct Answer", "Correct Explanation", "Wrong Options Explanation", "File Name(s)", "Exam", "Chapter Name", "Concept Name"] as const;
const CASE_HEADERS = ["Case Passage", "Sub-question", "Option A", "Option B", "Option C", "Option D", "Correct Answer", "Correct Explanation", "Wrong Options Explanation", "File Name(s)", "Exam", "Chapter Name", "Concept Name"] as const;
const normalized = (value: unknown) => String(value ?? "").trim();
const html = (value: string) => sanitizeRichText(value ? `<p>${value}</p>` : "");
const digest = (buffer: Buffer, courseId: string, mode: ImportMode, collection = "ORIGINAL", questionBankId = "") => createHash("sha256").update(buffer).update(courseId).update(mode).update(collection).update(questionBankId).digest("hex");

function workbookBuffer(contentBase64: string) {
  const buffer = Buffer.from(contentBase64, "base64");
  if (!buffer.length || buffer.length > 20_000_000) throw badRequest("INVALID_IMPORT_FILE", "Upload a non-empty Excel workbook smaller than 20 MB.");
  return buffer;
}

async function assertCourse(scope: QuestionScope, courseId: string) {
  const course = await prisma.course.findFirst({ where: { id: courseId, deletedAt: null, ...(scope.academyId ? { academyId: scope.academyId } : { academyId: null }) }, select: { id: true } });
  if (!course) throw notFound("COURSE_NOT_FOUND", "The selected course was not found in the current tenant.");
}

async function parseWorkbook(scope: QuestionScope, input: ImportRequest) {
  await assertCourse(scope, input.courseId);
  if (input.practiceCollection === "QUESTION_BANK" && !input.questionBankId) throw badRequest("QUESTION_BANK_REQUIRED", "Select the Question Bank that should receive this import.");
  if (input.practiceCollection !== "QUESTION_BANK" && input.questionBankId) throw badRequest("QUESTION_BANK_NOT_ALLOWED", "questionBankId is only valid for Question Bank imports.");
  if (input.questionBankId) {
    await prisma.$transaction((tx) => assertQuestionBankForWrite(
      tx,
      scope,
      input.questionBankId!,
      input.courseId,
    ));
  }
  if (!/\.xlsx$/i.test(input.fileName)) throw badRequest("INVALID_IMPORT_TYPE", "Questions must be uploaded using the provided .xlsx template.");
  const buffer = workbookBuffer(input.contentBase64);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer as never); } catch { throw badRequest("INVALID_IMPORT_FILE", "The uploaded file is not a readable Excel workbook."); }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw badRequest("EMPTY_IMPORT", "The workbook does not contain a worksheet.");
  const expected = input.mode === "normal" ? NORMAL_HEADERS : CASE_HEADERS;
  const actual = expected.map((_, index) => normalized(sheet.getRow(1).getCell(index + 1).value));
  const headerErrors: ValidationError[] = expected.flatMap((header, index) => actual[index] === header ? [] : [{ row: 1, field: `Column ${index + 1}`, problem: `Expected header \"${header}\".` }]);
  if (headerErrors.length) return { buffer, errors: headerErrors, questions: [] as QuestionInput[], rows: 0 };

  const files = await prisma.contentItem.findMany({ where: { courseId: input.courseId, kind: "FILE", deletedAt: null }, select: { id: true, name: true } });
  const chapters = await prisma.taxonomyChapter.findMany({
    where: { courseId: input.courseId },
    select: { id: true, name: true, subjectId: true, lessons: { select: { id: true, topics: { select: { id: true, name: true } } } } },
  });
  const filesByName = new Map<string, Array<{ id: string; name: string }>>();
  for (const file of files) {
    const key = file.name.trim().toLocaleLowerCase();
    filesByName.set(key, [...(filesByName.get(key) ?? []), file]);
  }
  const errors: ValidationError[] = [];
  const questions: QuestionInput[] = [];
  let previousPassage = "";
  let activeCase: QuestionInput | null = null;
  let dataRows = 0;
  const seen = new Set<string>();

  const resolveClassification = (chapterName: string, conceptName: string, row: number) => {
    if (!chapterName) errors.push({ row, field: "Chapter Name", problem: "Chapter Name is required." });
    if (!conceptName) errors.push({ row, field: "Concept Name", problem: "Concept Name is required." });
    const chapterMatches = chapters.filter((chapter) => chapter.name.trim().toLocaleLowerCase() === chapterName.toLocaleLowerCase());
    if (chapterName && chapterMatches.length !== 1) errors.push({ row, field: "Chapter Name", problem: chapterMatches.length ? `Chapter "${chapterName}" is ambiguous in this course.` : `Chapter "${chapterName}" was not found in the selected course.` });
    const chapter = chapterMatches[0];
    const topics = chapter?.lessons.flatMap((lesson) => lesson.topics.map((topic) => ({ ...topic, lessonId: lesson.id }))) ?? [];
    const topicMatches = topics.filter((topic) => topic.name.trim().toLocaleLowerCase() === conceptName.toLocaleLowerCase());
    if (conceptName && topicMatches.length !== 1) errors.push({ row, field: "Concept Name", problem: topicMatches.length ? `Concept "${conceptName}" is ambiguous in chapter "${chapterName}".` : `Concept "${conceptName}" was not found in chapter "${chapterName}".` });
    const topic = topicMatches[0];
    return { subjectId: chapter?.subjectId, chapterId: chapter?.id, lessonId: topic?.lessonId, topicId: topic?.id };
  };

  const resolveFiles = (raw: string, row: number) => {
    const names = [...new Set(raw.split(",").map((part) => part.trim()).filter(Boolean))];
    if (!names.length) {
      if (input.practiceCollection !== "QUESTION_BANK") errors.push({ row, field: "File Name(s)", problem: "At least one linked file is required for ordinary practice questions." });
      return [] as string[];
    }
    const ids: string[] = [];
    for (const name of names) {
      const matches = filesByName.get(name.toLocaleLowerCase()) ?? [];
      if (!matches.length) errors.push({ row, field: "File Name(s)", problem: `File \"${name}\" was not found in the selected course.` });
      else if (matches.length > 1) errors.push({ row, field: "File Name(s)", problem: `File name \"${name}\" is ambiguous in this course.` });
      else ids.push(matches[0].id);
    }
    return ids;
  };

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const values = expected.map((_, index) => normalized(sheet.getRow(rowNumber).getCell(index + 1).value));
    if (values.every((value) => !value)) continue;
    dataRows += 1;
    const base = input.mode === "normal" ? 0 : 1;
    const prompt = values[base];
    const options = values.slice(base + 1, base + 5);
    const answer = values[base + 5].toUpperCase();
    const rowStart = errors.length;
    if (!prompt) errors.push({ row: rowNumber, field: input.mode === "normal" ? "Question" : "Sub-question", problem: "Question text is required." });
    const suppliedOptions = options.flatMap((text, index) => text ? [{ optionLabel: String.fromCharCode(65 + index), html: html(text) }] : []);
    if (suppliedOptions.length < 2) errors.push({ row: rowNumber, field: "Options", problem: "Supply at least two answer options. Option C and Option D may be blank." });
    if (!/^[A-D]$/.test(answer)) errors.push({ row: rowNumber, field: "Correct Answer", problem: "Use exactly A, B, C, or D." });
    else if (!suppliedOptions.some((option) => option.optionLabel === answer)) errors.push({ row: rowNumber, field: "Correct Answer", problem: `Correct Answer ${answer} does not have a supplied option.` });
    const fileIndex = input.mode === "normal" ? 8 : 9;
    const examIndex = fileIndex + 1;
    const chapterIndex = fileIndex + 2;
    const conceptIndex = fileIndex + 3;
    const fileIds = resolveFiles(values[fileIndex], rowNumber);
    const examName = values[examIndex];
    const chapterName = values[chapterIndex];
    const conceptName = values[conceptIndex];
    if (!examName) errors.push({ row: rowNumber, field: "Exam", problem: "Exam is required." });
    const classification = resolveClassification(chapterName, conceptName, rowNumber);
    const duplicateKey = `${input.mode}|${values[0].toLocaleLowerCase()}|${prompt.toLocaleLowerCase()}`;
    if (seen.has(duplicateKey)) errors.push({ row: rowNumber, field: "Question", problem: "Duplicate question exists within this workbook." });
    seen.add(duplicateKey);
    if (errors.length !== rowStart) continue;
    const optionInputs = suppliedOptions;
    if (input.mode === "normal") {
      questions.push({ kind: "NORMAL_MCQ", status: "DRAFT", practiceCollection: input.practiceCollection ?? "ORIGINAL", questionBankId: input.questionBankId, courseId: input.courseId, contentItemIds: fileIds, questionHtml: html(prompt), options: optionInputs, correctOptionId: answer, correctExplanationHtml: html(values[6]), premiumWrongOptionsExplanationHtml: html(values[7]), examName, chapterName, conceptName, ...classification });
      continue;
    }
    const passage = values[0] || previousPassage;
    if (!passage) { errors.push({ row: rowNumber, field: "Case Passage", problem: "The first row of a case must contain its passage." }); continue; }
    if (values[0]) {
      previousPassage = values[0];
      activeCase = { kind: "CASE_MCQ", status: "DRAFT", practiceCollection: input.practiceCollection ?? "ORIGINAL", questionBankId: input.questionBankId, courseId: input.courseId, contentItemIds: [...fileIds], caseHtml: html(passage), subQuestions: [] };
      questions.push(activeCase);
    } else if (!activeCase) {
      errors.push({ row: rowNumber, field: "Case Passage", problem: "No previous case passage is available." });
      continue;
    }
    activeCase!.contentItemIds = [...new Set([...(activeCase!.contentItemIds ?? []), ...fileIds])];
    activeCase!.subQuestions!.push({
      questionHtml: html(prompt),
      options: optionInputs,
      correctOptionId: answer,
      correctExplanationHtml: html(values[7]),
      premiumWrongOptionsExplanationHtml: html(values[8]),
      courseId: input.courseId,
      examName,
      chapterName,
      conceptName,
      ...classification,
    });
  }
  if (!dataRows) errors.push({ row: 2, field: "Workbook", problem: "Add at least one question row." });

  if (!errors.length) {
    const prompts = questions.map((question) => question.kind === "CASE_MCQ" ? question.caseHtml! : question.questionHtml!);
    const existing = await prisma.question.findMany({ where: { courseId: input.courseId, academyId: scope.academyId ?? null, deletedAt: null, questionBankId: input.questionBankId ?? null, OR: [{ questionHtml: { in: prompts } }, { caseHtml: { in: prompts } }] }, select: { questionHtml: true, caseHtml: true } });
    const existingText = new Set(existing.flatMap((item) => [item.questionHtml, item.caseHtml]).filter(Boolean));
    questions.forEach((question, index) => { const text = question.kind === "CASE_MCQ" ? question.caseHtml! : question.questionHtml!; if (existingText.has(text)) errors.push({ row: index + 2, field: "Question", problem: "An equivalent question already exists in this course." }); });
  }
  return { buffer, errors, questions, rows: dataRows };
}

export async function buildTemplate(mode: ImportMode) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(mode === "normal" ? "Normal MCQ" : "Case MCQ");
  const headers = mode === "normal" ? NORMAL_HEADERS : CASE_HEADERS;
  sheet.addRow([...headers]);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.columns = headers.map((header) => ({ header, key: header, width: Math.max(18, header.length + 4) }));
  if (mode === "normal") sheet.addRow(["Sample question", "A", "B", "", "", "A", "Why A is correct", "Why B is wrong", "Example.pdf", "CA Intermediate", "Accounting", "Journal entries"]);
  else {
    sheet.addRow(["Sample case passage", "First sub-question", "A", "B", "C", "", "A", "Why A is correct", "Why the other options are wrong", "Example.pdf", "CA Intermediate", "Accounting", "Journal entries"]);
    sheet.addRow(["", "Second sub-question in the same case", "A", "B", "", "", "B", "Why B is correct", "Why A is wrong", "Example.pdf", "CA Intermediate", "Accounting", "Journal entries"]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function validateImport(scope: QuestionScope, input: ImportRequest) {
  const parsed = await parseWorkbook(scope, input);
  return { valid: parsed.errors.length === 0, totalRows: parsed.rows, questionCount: parsed.questions.length, errors: parsed.errors, validationDigest: digest(parsed.buffer, input.courseId, input.mode, input.practiceCollection, input.questionBankId) };
}

export async function commitImport(scope: QuestionScope, input: ImportRequest & { validationDigest: string }) {
  const parsed = await parseWorkbook(scope, input);
  if (digest(parsed.buffer, input.courseId, input.mode, input.practiceCollection, input.questionBankId) !== input.validationDigest) throw conflict("IMPORT_CHANGED", "The workbook or selected Question Bank changed after validation. Validate it again.");
  if (parsed.errors.length) throw badRequest("IMPORT_VALIDATION_FAILED", "The workbook contains invalid rows. No questions were imported.", { rows: parsed.errors.map((error) => `Row ${error.row} · ${error.field}: ${error.problem}`) });
  const created = await createQuestionsAtomically(scope, parsed.questions);
  return { imported: created.length, questions: created };
}
