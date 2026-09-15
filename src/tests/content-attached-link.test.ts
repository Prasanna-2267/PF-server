import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../errors/api-error.js";
import { normalizeContentAttachedLinkInput } from "../services/contentAttachedLinkService.js";

test("attached content links normalize safe web URLs and descriptions", () => {
  assert.deepEqual(
    normalizeContentAttachedLinkInput({
      url: "  https://example.com/study guide?part=1  ",
      description: "  Worked examples  ",
    }),
    {
      url: "https://example.com/study%20guide?part=1",
      description: "Worked examples",
    },
  );
});

test("attached content links reject malformed and unsafe protocols", () => {
  for (const url of ["not a URL", "javascript:alert(1)", "file:///private/note.pdf", "ftp://example.com/file"]) {
    assert.throws(
      () => normalizeContentAttachedLinkInput({ url, description: "Resource" }),
      (error: unknown) => error instanceof ApiError && error.statusCode === 400,
    );
  }
});

test("attached content links require bounded URL and description values", () => {
  const cases = [
    { url: "", description: "Resource" },
    { url: "https://example.com", description: "" },
    { url: `https://example.com/${"a".repeat(2_100)}`, description: "Resource" },
    { url: "https://example.com", description: "a".repeat(2_001) },
  ];
  for (const input of cases) {
    assert.throws(
      () => normalizeContentAttachedLinkInput(input),
      (error: unknown) => error instanceof ApiError && error.statusCode === 400,
    );
  }
});
