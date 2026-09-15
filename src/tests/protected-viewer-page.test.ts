import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  pdfJsClassicPath,
  pdfJsClassicWorkerPath,
  protectedPdfViewerHtml,
  protectedPdfViewerScript,
} from "../services/protectedViewerPage.js";

test("protected PDF viewer uses WebView-compatible classic scripts", () => {
  assert.equal(existsSync(pdfJsClassicPath), true);
  assert.equal(existsSync(pdfJsClassicWorkerPath), true);
  assert.match(protectedPdfViewerHtml, /pdf-classic-v5\.min\.js/);
  assert.match(protectedPdfViewerHtml, /pdf-classic-worker-v5\.min\.js/);
  assert.match(protectedPdfViewerHtml, /pdf-viewer-v3\.js/);
  assert.doesNotMatch(protectedPdfViewerHtml, /type="module"/);
  assert.doesNotMatch(protectedPdfViewerScript, /^\s*import\s/m);
});
