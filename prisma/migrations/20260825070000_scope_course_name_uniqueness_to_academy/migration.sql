-- Courses are tenant-owned.  A name may be reused by another academy, but not
-- within the same academy (case- and surrounding-whitespace-insensitive).
DROP INDEX IF EXISTS "Course_name_ci_key";

CREATE UNIQUE INDEX "Course_academyId_name_ci_key"
ON "Course" ("academyId", LOWER(BTRIM("name")))
WHERE "academyId" IS NOT NULL;

-- Keep the pre-existing platform-course behavior for records that are not
-- attached to an academy.  PostgreSQL considers NULL values distinct in a
-- compound unique index, so this partial index is intentional.
CREATE UNIQUE INDEX "Course_platform_name_ci_key"
ON "Course" (LOWER(BTRIM("name")))
WHERE "academyId" IS NULL;
