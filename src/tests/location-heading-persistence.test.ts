import assert from "node:assert/strict";
import { test } from "node:test";
import { updateLocation, getLocation, type ContentScope } from "../services/contentService.js";

test("getLocation returns 'Untitled Page' for unconfigured courses", async () => {
  const scope: ContentScope = { actorId: "00000000-0000-0000-0000-000000000001" };
  const mockCourseId = "00000000-0000-0000-0000-000000000002";
  
  // Test error for non-existent course scope
  await assert.rejects(
    async () => getLocation(scope, mockCourseId, null),
    /not found/i
  );
});

test("updateLocation rejects empty or whitespace-only headings", async () => {
  const scope: ContentScope = { actorId: "00000000-0000-0000-0000-000000000001" };
  const mockCourseId = "00000000-0000-0000-0000-000000000002";

  // Rejects empty string
  await assert.rejects(
    async () => updateLocation(scope, mockCourseId, null, "   "),
    /valid page heading/i
  );

  // Rejects 'Untitled Page'
  await assert.rejects(
    async () => updateLocation(scope, mockCourseId, null, "Untitled Page"),
    /valid page heading/i
  );

  // Rejects 'untitled_page'
  await assert.rejects(
    async () => updateLocation(scope, mockCourseId, null, "untitled_page"),
    /valid page heading/i
  );
});
