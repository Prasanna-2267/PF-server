import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { buildTemplate } from "../services/questionImportService.js";

const headers = async (mode: "normal" | "case") => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildTemplate(mode) as never);
  const sheet = workbook.worksheets[0];
  return Array.from({ length: sheet.columnCount }, (_, index) => String(sheet.getRow(1).getCell(index + 1).value));
};

test("normal MCQ template keeps the finalized exact columns", async () => {
  assert.deepEqual(await headers("normal"), [
    "Question", "Option A", "Option B", "Option C", "Option D", "Correct Answer",
    "Correct Explanation", "Wrong Options Explanation", "File Name(s)",
    "Exam", "Chapter Name", "Concept Name",
  ]);
});

test("case MCQ template keeps the finalized exact columns", async () => {
  assert.deepEqual(await headers("case"), [
    "Case Passage", "Sub-question", "Option A", "Option B", "Option C", "Option D",
    "Correct Answer", "Correct Explanation", "Wrong Options Explanation", "File Name(s)",
    "Exam", "Chapter Name", "Concept Name",
  ]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildTemplate("case") as never);
  const example = workbook.worksheets[0].getRow(2);
  assert.equal(example.getCell(8).value, "Why A is correct");
  assert.equal(example.getCell(9).value, "Why the other options are wrong");
  assert.equal(example.getCell(10).value, "Example.pdf");
});
