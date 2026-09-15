# Parallax Flow - Final Production Security and Academy Admin Release Gate

Verification date: 2026-08-25 (Asia/Calcutta)

## Final verdict

**ACADEMY ADMIN MODULE - NOT YET PRODUCTION READY**

The application, authorization, database, build, test, health, and production-runtime dependency gates pass. The remaining P0 release blocker is a live end-to-end verification against an approved non-production Cloudflare R2 bucket. Browser automation was unavailable, so visual/browser-only checks are also recorded as unverified rather than assumed.

No production API, production database, Supabase project, or production R2 bucket was contacted during this gate.

## 1. Changes made

- Added a multi-stage production backend image in `Dockerfile`.
- Kept Prisma CLI/config tooling in the build/migration stage only.
- Installed runtime dependencies with `npm ci --omit=dev --omit=optional --ignore-scripts`.
- Preserved `@prisma/client` and `@prisma/adapter-pg` in the runtime.
- Added OpenSSL to the build/runtime base so Prisma does not start from an unsupported SSL environment.
- Configured the runtime to execute as the non-root `node` user.
- Added an image health check against `/health/ready`.
- Added `.dockerignore` to exclude secrets, local dependencies, build output, temporary evidence, and reports from the Docker build context.
- Did not change application architecture, Prisma schema, migrations, database models, or Academy Admin functionality.

## 2. Security findings

### deepmerge-ts advisory

Commands:

```text
npm ls deepmerge-ts --all
npm explain deepmerge-ts
npm audit --json
npm ls deepmerge-ts --omit=dev
npm audit --omit=dev --json
```

Resolved dependency path:

```text
prisma@7.9.1
  -> @prisma/config@7.9.1
     -> deepmerge-ts@7.1.5
```

The advisory is GHSA-ggr8-5vv4-36mx (recursive-object stack exhaustion, affected versions below 8.0.0). `deepmerge-ts` is not imported by the application and is required only by Prisma CLI/config tooling.

The full backend development/build tree reports three high findings (`prisma`, `@prisma/config`, and `deepmerge-ts`) that represent this one transitive advisory. npm suggests Prisma 6.12.0 as a breaking downgrade; that unsafe remediation was not applied.

`npm audit --omit=dev` alone is insufficient with this lockfile because npm auto-installs Prisma as an optional peer of `@prisma/client`. The deployment strategy therefore also omits optional peer dependencies and skips install scripts after the generated client has been built in the isolated build stage.

Clean runtime evidence:

```text
npm ci --omit=dev --omit=optional --ignore-scripts
npm ls prisma @prisma/config deepmerge-ts --omit=dev --omit=optional
  -> (empty)
npm audit --omit=dev --omit=optional --json
  -> 0 vulnerabilities
```

The built image was inspected directly and contains none of these directories:

```text
node_modules/prisma
node_modules/@prisma/config
node_modules/deepmerge-ts
```

### Dependency report

| Dependency | Version | Context | Vulnerable? | Required at runtime? | Action |
| --- | --- | --- | --- | --- | --- |
| `deepmerge-ts` | 7.1.5 | Prisma CLI/config transitive dependency | Yes | No | Excluded from runtime image; monitor Prisma upstream |
| `prisma` | 7.9.1 | Development, build, migration tooling | Transitively flagged | No | Retained only outside runtime; no forced downgrade |
| `@prisma/config` | 7.9.1 | Prisma CLI/config tooling | Transitively flagged | No | Excluded from runtime image |
| `@prisma/client` | 7.9.1 | Application runtime | No current npm advisory | Yes | Retained |
| `@prisma/adapter-pg` | 7.9.1 | Application runtime | No current npm advisory | Yes | Retained |

Frontend dependency audit: **PASS, 0 vulnerabilities**.

Backend build/tooling audit: **3 high findings from the single Prisma CLI/config chain above**.

Backend production runtime audit: **PASS, 0 vulnerabilities**.

## 3. Academy Admin authorization verification

Source navigation and route inspection confirms exactly these six Academy Admin modules:

1. Overview
2. Students
3. Courses
4. Content
5. Questions
6. Broadcast

Academy Admin navigation/routes do not expose Packages, Orders, Coupons, Store, Store Merchandising, Revenue, Academies, Admissions, Analytics, Settings, or Notifications.

Disposable-database HTTP verification passed:

- Academy Admin A to Academy A: allowed.
- Academy Admin A to Academy B students, courses, content, questions, and broadcasts: denied.
- Client-supplied academy IDs in query, body, or headers cannot replace the server-derived academy context.
- Multiple active Academy Admin memberships fail closed with HTTP 409.
- Student access to Academy/Super Admin resources is denied.
- Academy Admin access to Super Admin commerce endpoints is denied with HTTP 403.
- Academy Admin attempts to create store/promotion broadcasts or paid/store content are rejected.
- Academy Admin store-section creation is not mounted.
- Super Admin commercial and cross-academy access remains available.
- Removed Academy routes for admissions, analytics, settings, and notifications return HTTP 404 after authentication.

## 4. Database verification

Target used exclusively:

```text
Container: pf-phase4-postgres
PostgreSQL: 16
Host: 127.0.0.1:55432
Database: parallax_flow_test
User: pf_test
```

Results:

- Docker Desktop 29.6.1: available.
- PostgreSQL: accepting connections.
- `npx prisma validate`: PASS.
- `npx prisma generate`: PASS, Prisma Client 7.9.1 generated.
- `npx prisma migrate status`: PASS.
- Migration ledger: 17 migrations, database schema up to date.
- Deterministic seed: PASS twice in succession.
- Full integration setup recreated only the disposable database.
- Academy foreign-key/tenant constraints, soft-delete filtering, audit redaction, commerce uniqueness/idempotency, and representative `EXPLAIN` plans: PASS.
- No migration or schema change was created.

## 5. Backend verification

| Gate | Result |
| --- | --- |
| Unit tests | PASS - 31 tests, 0 failures, 0 skips |
| Full disposable PostgreSQL integration | PASS - 49 tests, 0 failures, 0 skips |
| Admissions embedded suite | PASS - 34 checks |
| Analytics embedded suite | PASS - 24 checks |
| Academy tenant isolation embedded suite | PASS - 13 checks |
| Notifications embedded suite | PASS - 16 checks |
| Settings embedded suite | PASS - 19 checks |
| TypeScript typecheck | PASS |
| Production build | PASS |
| Production Docker image build | PASS |
| Image runtime user | PASS - `node` |
| Image health status | PASS - `healthy` |
| `/health/live` | PASS - HTTP 200 |
| `/health/ready` | PASS - HTTP 200 with disposable PostgreSQL |

The full integration suite also passed authentication/session rotation, HTTP error envelopes, RBAC/IDOR, admissions concurrency, storage metadata, questions/taxonomy sanitization, broadcast delivery, durable jobs, notification delivery abstraction, commerce pricing/idempotency/webhook replay, Super Admin, Student, public catalog/contact, audit logging, database integrity, and query-plan checks.

## 6. Frontend verification

| Gate | Result |
| --- | --- |
| Vitest | PASS - 100 tests across 18 files |
| TypeScript typecheck | PASS |
| Vite production build | PASS - 2,103 modules transformed |
| Dependency audit | PASS - 0 vulnerabilities |

The build includes the exact six Academy Admin pages and does not register excluded Academy Admin commerce/global routes.

## 7. R2 verification

### Verified

- Object keys are deterministic and course/page scoped.
- Filenames and upload metadata are sanitized and validated.
- Presigned uploads include required signed metadata without exposing credentials.
- Object existence is checked before publication.
- Authenticated downloads use short-lived signed URLs; the tested download TTL is 300 seconds.
- Cross-academy content access is rejected through the API/service tenant boundary.
- Public catalog responses do not expose protected storage paths.
- Content deletion removes database visibility and calls the storage deletion abstraction.
- These behaviors passed unit and disposable PostgreSQL integration tests using isolated provider test doubles.

### Unverified release blocker

No approved non-production Cloudflare R2 account, bucket, or test credentials were available. Consequently, the complete live chain below was not executed:

```text
Browser -> Academy API -> PostgreSQL metadata -> Cloudflare R2 PUT/HEAD/GET/DELETE -> Student download
```

This is the only P0 blocker preventing the production-ready declaration. It must be tested with a disposable/non-production R2 bucket and test identities; production credentials must not be used for this rehearsal.

## 8. Browser verification

Status: **UNVERIFIED - browser tooling unavailable**.

The browser runtime was initialized and queried after reading its troubleshooting guidance. It reported no connected in-app or extension browser (`[]`). Therefore no claim is made for manual visual navigation, responsive layout, console state, upload UI, folder creation UI, page-heading refresh persistence, question creation UI, or broadcast creation UI.

This is not treated as a tooling-available acceptance failure, but the live R2 blocker still requires an actual browser/API smoke when a browser and a non-production R2 bucket are available.

## 9. Exact remaining actions

1. Provide approved disposable/non-production Cloudflare R2 endpoint, bucket, access key, and secret key through secure environment injection.
2. Connect the in-app browser or browser extension.
3. Run Academy Admin Content upload, object verification, signed Student download, delete/revocation, cross-academy denial, and expiry checks against that non-production bucket.
4. Exercise Super Admin academy detail and all six Academy Admin navigation flows, refresh persistence, and console/network inspection.
5. Re-run the production-ready verdict after those checks pass.

Until then, do not label this module `ACADEMY ADMIN MODULE - PRODUCTION READY`.
