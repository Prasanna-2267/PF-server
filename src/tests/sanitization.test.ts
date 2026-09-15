import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeRichText } from "../utils/sanitize-html.js";

test("question rich text removes executable markup and unsafe URLs", () => {
  const cleaned = sanitizeRichText('<p onclick="steal()">Safe</p><script>alert(1)</script><a href="javascript:alert(1)">bad</a>');
  assert.equal(cleaned.includes("onclick"), false);
  assert.equal(cleaned.includes("script"), false);
  assert.equal(cleaned.includes("javascript:"), false);
  assert.equal(cleaned.includes("Safe"), true);
});
