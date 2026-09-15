import assert from "node:assert/strict";
import { test } from "node:test";
import { validateQuestionShape } from "../services/questionService.js";
import { assertFileNameMatchesMime } from "../utils/upload-validation.js";

test("upload validation rejects traversal, active SVG, missing extensions, and MIME mismatches", () => {
  assert.doesNotThrow(() => assertFileNameMatchesMime("lesson.pdf", "application/pdf"));
  assert.doesNotThrow(() => assertFileNameMatchesMime("photo.JPEG", "image/jpeg"));
  assert.doesNotThrow(() => assertFileNameMatchesMime("lesson-plan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"));
  assert.doesNotThrow(() => assertFileNameMatchesMime("revision-deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"));
  assert.doesNotThrow(() => assertFileNameMatchesMime("marks.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
  assert.throws(() => assertFileNameMatchesMime("..%2Fsecrets.pdf", "application/pdf"));
  assert.throws(() => assertFileNameMatchesMime("payload.svg", "image/svg+xml"));
  assert.throws(() => assertFileNameMatchesMime("payload.pdf.exe", "application/pdf"));
  assert.throws(() => assertFileNameMatchesMime("no-extension", "image/png"));
});

test("case MCQ validation requires a valid answer for every sub-question", () => {
  const base = { kind: "CASE_MCQ" as const, contentItemIds: ["linked-file"], caseHtml: "<p>Case</p>", subQuestions: [{ questionHtml: "<p>Q1</p>", options: [{ optionLabel: "A", html: "One" }, { optionLabel: "B", html: "Two" }], correctOptionId: "A" }] };
  assert.equal(validateQuestionShape(base).length, 0);
  assert.throws(() => validateQuestionShape({ ...base, subQuestions: [{ ...base.subQuestions[0], correctOptionId: "C" }] }));
  assert.throws(() => validateQuestionShape({ ...base, subQuestions: [{ ...base.subQuestions[0], questionHtml: "<script>alert(1)</script>" }] }));
});

test("case descriptive validation rejects MCQ answer structures", () => {
  assert.throws(() => validateQuestionShape({ kind: "CASE_DESCRIPTIVE", contentItemIds: ["linked-file"], caseHtml: "Case", subQuestions: [{ questionHtml: "Explain", options: [{ optionLabel: "A", html: "One" }, { optionLabel: "B", html: "Two" }], correctOptionId: "A" }] }));
  assert.throws(() => validateQuestionShape({ kind: "NORMAL_DESCRIPTIVE", contentItemIds: ["linked-file"], questionHtml: "Explain", correctOptionId: "A" }));
  assert.throws(() => validateQuestionShape({ kind: "CASE_MCQ", contentItemIds: ["linked-file"], caseHtml: "Case", options: [{ optionLabel: "A", html: "One" }, { optionLabel: "B", html: "Two" }], correctOptionId: "A", subQuestions: [{ questionHtml: "Q", options: [{ optionLabel: "A", html: "One" }, { optionLabel: "B", html: "Two" }], correctOptionId: "A" }] }));
});

test("ordinary questions require a linked file while Question Bank records are self-contained", () => {
  const question = {
    kind: "NORMAL_MCQ" as const,
    questionHtml: "Choose one",
    options: [{ optionLabel: "A", html: "Yes" }, { optionLabel: "B", html: "No" }],
    correctOptionId: "A",
  };
  assert.throws(() => validateQuestionShape(question), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "QUESTION_FILES_REQUIRED"));
  assert.doesNotThrow(() => validateQuestionShape({ ...question, contentItemIds: ["linked-file"] }));
  assert.doesNotThrow(() => validateQuestionShape({ ...question, practiceCollection: "QUESTION_BANK", questionBankId: "bank-id" }));
});

test("Question Bank validation accepts both supported MCQ shapes and rejects descriptive questions", () => {
  assert.doesNotThrow(() => validateQuestionShape({
    kind: "NORMAL_MCQ",
    practiceCollection: "QUESTION_BANK",
    questionBankId: "bank-normal",
    questionHtml: "Two-option bank question",
    options: [{ optionLabel: "A", html: "Yes" }, { optionLabel: "B", html: "No" }],
    correctOptionId: "A",
  }));
  assert.doesNotThrow(() => validateQuestionShape({
    kind: "CASE_MCQ",
    practiceCollection: "QUESTION_BANK",
    questionBankId: "bank-case",
    caseHtml: "Case passage",
    subQuestions: [{
      questionHtml: "Case question",
      options: [{ optionLabel: "A", html: "One" }, { optionLabel: "B", html: "Two" }, { optionLabel: "C", html: "Three" }],
      correctOptionId: "C",
    }],
  }));
  assert.throws(() => validateQuestionShape({
    kind: "NORMAL_DESCRIPTIVE",
    practiceCollection: "QUESTION_BANK",
    questionBankId: "bank-descriptive",
    questionHtml: "Unsupported descriptive bank question",
  }));
});
