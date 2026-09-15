# Parallax Flow — Phase 3 Backend Production Readiness Report

Date: 2026-08-21  
Scope: `server/` and read-only frontend compatibility review  
Database action taken: **none** — no Supabase, staging, or production connection was attempted

## 1. Executive verdict

**Verdict: NOT YET PRODUCTION READY.** The backend source is substantially API-complete and its local runtime, type, build, schema, unit, boundary, and static security checks are green. No confirmed critical code vulnerability remains from this review. Production approval is nevertheless blocked by evidence gaps and operational controls that cannot be honestly waived:

1. The real production migration ledger and schema drift are unverified. The local Phase 2C migration is still undeployed.
2. No isolated PostgreSQL test database was supplied, so database-writing, end-to-end authorization, migration-deploy, provider, webhook-concurrency, and job-recovery integration cases were not executed.
3. `npm audit` reports three high-severity findings through Prisma's `deepmerge-ts` dependency. The offered automatic remediation is a breaking Prisma downgrade and was not forced.
4. Rate limiting is process-local, not shared across replicas. Durable jobs are persisted, but there is no proven production worker supervisor, distributed lease heartbeat, dead-letter operator flow, or metrics/alerting.
5. The current frontend is not backend-compatible: authentication remains mocked, authenticated API calls do not consistently send bearer tokens, two student admission URLs are wrong, much of the UI still uses mock repositories, and the logo client uses an obsolete one-step contract. The frontend was not modified in this phase.

The backend is **ready for a staging migration rehearsal and isolated integration campaign**, subject to the runbook in section 6. A production release requires every P0 gate in section 14 to close.

## 2. Scope and evidence

Reviewed:

- Express application construction, middleware ordering, error handling, request context, logging, CORS, content-type enforcement, and rate limiting.
- Authentication token, password, Google authentication, session, refresh rotation, logout, and user-governance paths.
- Super Admin, Academy Admin, Student, public catalog/contact, storage/content, questions/taxonomy, broadcast, notifications/templates/delivery, commerce/payment/refund, audit/security-event, analytics, admissions, and durable-job code.
- Prisma schema and all 17 migrations in chronological order.
- All route files and mount points. The concrete mounted inventory is 200 endpoints after expanding lifecycle loops and the shared content/question routers.
- All existing automated tests plus new attack and domain-validation tests.
- Frontend API usage read-only. No file under `src/`, `public/`, or the frontend configuration was changed.

Not evidenced in this environment:

- The contents of `_prisma_migrations` in staging or production.
- A clean migration from zero against PostgreSQL or an upgrade against a production clone.
- Any real S3-compatible storage, email, Google, payment, Supabase, or other external-provider call.
- Database-backed concurrency, tenant IDOR, refresh replay, coupon exhaustion, webhook replay, or worker crash recovery under load.
- Load, soak, failover, backup-restore, and multi-replica rate-limit behavior.

## 3. Changes made during the audit

These changes correct confirmed defects; they do not add product features.

- Durable worker completion and retry updates now require the same processing state and worker lease. Cancellation or lease loss can no longer be overwritten by a late completion/failure update. Per-job `maxAttempts` now governs stale recovery, exhausted pending jobs fail, and batch size is capped.
- Payment webhooks can no longer convert cancelled/refunded orders into paid orders or overwrite their terminal state with a failure.
- Case-question validation now validates every sub-question, answer label, descriptive/MCQ shape, top-level answer prohibition, sanitized required content, and sub-question taxonomy during updates.
- Uploads now reject path separators, encoded traversal, unknown extensions, and filename/MIME mismatches. SVG was removed from content and academy-logo acceptance because active SVG is unsafe to serve from the application storage origin.
- Previously unbounded student, notification, email, broadcast, content-copy, template, public-detail, coupon-target, and related-record reads now have pagination or explicit safety caps.
- Duplicate, unreachable Academy question list/create handlers were removed; the full question router is now the sole handler.
- The undeployed Phase 2C migration was corrected so it no longer recreates indexes already created by earlier migrations. Redundant commerce checks were removed because the earlier commerce migration already provides validated XOR constraints. The Prisma-only package composite unique declaration was removed to match the existing partial, case-insensitive active-package index.
- Added read-only migration preflight SQL and post-migration constraint-validation SQL.
- Added a fail-closed integration database guard, migration/seed preparation command, deterministic cleanup mechanism, route-boundary integration matrix, expanded JWT/refresh attacks, upload attacks, and question-shape tests.

## 4. Runtime and middleware audit

The runtime is coherent and routes are mounted in a safe order:

1. request ID/context and structured request logger;
2. Helmet and explicit-origin CORS;
3. health routes;
4. global API rate limit;
5. raw-body payment webhook route;
6. JSON content-type enforcement and bounded JSON parser;
7. auth, role, tenant, and domain routers;
8. controlled 404 and centralized error handler.

Positive findings:

- `x-powered-by` is disabled; Helmet is enabled.
- Payment webhook signatures receive the original raw body before JSON parsing.
- JSON and webhook body sizes are bounded.
- CORS production origins must be explicit HTTPS origins without paths.
- Zod validation is strict on mutation bodies; no direct `req.body` to Prisma writes or TypeScript suppression casts were found.
- Prisma known errors, validation errors, oversized bodies, unsupported content types, 404, 409, 415, 429, 502, and 503 paths produce controlled envelopes without stack traces.
- Health liveness is database-independent; readiness checks database connectivity.

Remaining risks:

- **P1:** rate limits use in-memory maps. They reset on restart and can be bypassed across replicas. Use Redis/managed edge limiting and distinct policies for login, refresh, checkout, upload intents/finalize, contact, and webhooks.
- **P1:** there are no response timeouts, request cancellation propagation, or provider circuit breakers.
- **P2:** no OpenTelemetry traces, Prometheus-style metrics, or explicit SLOs exist.
- **P2:** authorization failures and suspicious tenant/header behavior are logged as requests but are not consistently persisted as `SecurityEvent` records.

## 5. Authentication, authorization, tenant, and IDOR audit

### Authentication

- Access tokens are strict HS256 JWTs with fixed `alg`/`typ`, issuer, audience, access type, subject, session ID, issued-at tolerance, expiration, length limit, and timing-safe signature comparison.
- Every authenticated request reloads the database session, user status/deletion, role activity, and permissions. Role changes and account disablement therefore take effect without waiting for JWT expiry.
- Passwords use scrypt. Unknown-user login still performs password work, reducing direct account-enumeration timing differences.
- Refresh tokens are opaque, stored only as hashes, and rotated with a compare-and-swap update. Concurrent replay has a single database winner.
- Logout revokes the server-side session. Last-Super-Admin governance uses a serializable transaction.
- Google authentication verifies the ID token server-side against the configured client ID; browser-decoded claims are not trusted by this backend.

Attack tests now cover malformed tokens, forged signatures, algorithm confusion, wrong issuer/audience, future issue time, expiration, oversize tokens, malformed refresh tokens, hash mismatch, and password failure.

Remaining risks:

- **P1:** login/refresh abuse protection is only process-local.
- **P1:** no end-to-end database test was run for simultaneous refresh replay, revoked/expired sessions, role changes mid-session, or disabled users.
- **P2:** no backend password-reset/recovery lifecycle is present.

### Authorization and tenant resolution

- `/api/admin` requires an authenticated active Super Admin. Sensitive legacy Admin operations also require permission keys.
- `/api/academy` requires authentication and the Academy Admin middleware before any domain handler.
- `/api/student` requires the platform `student` role.
- Academy context comes only from the explicit `x-academy-id` header and a live Academy Admin membership. Body/query/path academy IDs cannot silently select tenant context.
- Academy services consistently scope resources by `academyId` or first prove that a parent course/resource belongs to the current tenant. Student resources are constrained by user ID, membership, enrollment, or entitlement.
- Super Admin cross-tenant access is explicit and is not inferred from user input.

The static IDOR review found no confirmed cross-tenant read/write path. Existing tenant-boundary tests report 13/13 assertions passing. Database-backed IDOR tests remain a P0 release gate.

## 6. Migration audit and staging-first runbook

### Migration inventory and risk

| Migration | Domain | Risk assessment |
|---|---|---|
| `20260818000000` | users/auth roles/sessions | Foundational; verify seeded roles/permissions and existing identities. |
| `20260818191413` | courses/subjects | Functional case-insensitive uniqueness can reject dirty legacy data. |
| `20260819044129` | content hierarchy | Multiple FKs and partial unique indexes; verify duplicate roots/sibling names. |
| `20260819050348` | packages | Partial case-insensitive active slug uniqueness. |
| `20260819053909` | question bank/taxonomy | Many restrictive FKs and option unique indexes. |
| `20260819061500` | commerce/entitlements | Monetary and XOR checks; highest legacy-data sensitivity among early migrations. |
| `20260819070000` | broadcasts | Many relations and partial event uniqueness. |
| `20260819124214` | academy multitenancy | Tenant tables/FKs; Academy delete behavior must be rehearsed. |
| `20260819125450` | platform settings | Low/additive. |
| `20260819130206` | audit/security | Additive, but retention/storage growth needs policy. |
| `20260820000000` | Phase 2 tenant columns/enrollment | Drops global course-code index and replaces it with nullable tenant-scoped uniqueness; platform courses with `academyId IS NULL` can share codes because PostgreSQL treats nulls as distinct. Review intent. |
| `20260820084319` | academy logo | Low/additive. |
| `20260820120000` | admissions | Adds admission tables/indexes/FKs. |
| `20260820182621` | notifications | Drops UUID defaults on four existing tables and creates notification tables without defaults, relying on application-generated IDs. Rehearse every create path. This migration's real deployment state is unknown. |
| `20260821090000` | password/refresh | Additive authentication columns/table; existing accounts need an intentional credential bootstrap policy. |
| `20260821100000` | notification hardening | Additive dispatch state and explicit individual targets. |
| `20260821120000` | Phase 2C operational reliability | Local and undeployed. Creates eight tables, FKs/indexes, two `NOT VALID` checks, and pending-invitation uniqueness. Must be staged first. |

The initial Phase 2C SQL contained guaranteed duplicate-index failures. Those statements have been removed locally because the migration has not been deployed. Do not edit an already-applied migration; if any environment reports this checksum as applied, stop and reconcile with a forward migration.

### Exact safe sequence

1. Freeze backend schema changes and obtain a restorable staging clone/snapshot of production through the database provider.
2. Set a dedicated staging connection variable. Never paste production credentials into the commands below.
3. Confirm hostname, database, project ID, and branch with a second operator.
4. Run the read-only preflight, then status, then deploy only to staging:

```powershell
Set-Location server
npm.cmd ci
npm.cmd run prisma:validate
npm.cmd run prisma:generate

$env:DATABASE_URL = $env:PF_STAGING_DATABASE_URL
$env:DIRECT_URL = $env:PF_STAGING_DATABASE_URL
npx.cmd prisma migrate status
psql.exe $env:PF_STAGING_DATABASE_URL -v ON_ERROR_STOP=1 -f prisma/phase-2c-preflight.sql
npx.cmd prisma migrate deploy
psql.exe $env:PF_STAGING_DATABASE_URL -v ON_ERROR_STOP=1 -f prisma/phase-2c-validate-constraints.sql
npx.cmd prisma migrate status
```

Expected preflight conditions:

- all three `*_already_exists` values are false;
- invitation, content, and question-option violation queries return zero rows;
- all five required earlier index names are present;
- `_prisma_migrations` contains no failed, rolled-back, partial, manually renamed, or unexpected entry;
- the latest local migration is absent before deploy and present with `finished_at` afterward.

5. Run the full isolated integration suite against a separate loopback database named with a delimited `test`, `testing`, or `ci` marker:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/parallax_flow_test'
$env:DATABASE_URL = $env:TEST_DATABASE_URL
$env:DIRECT_URL = $env:TEST_DATABASE_URL
$env:RUN_BACKEND_INTEGRATION = '1'
npm.cmd run test:integration:full
```

`test:integration:prepare` runs `migrate deploy`, truncates only the guarded disposable database while preserving `_prisma_migrations`, then applies deterministic role/permission seeds. The guard rejects remote hosts, database names without a test marker, mismatched runtime/test URLs, and missing opt-in.

6. Exercise staging storage, payment, email, login/refresh/logout, tenant A/B denial, worker crash/retry, checkout replay, webhook replay, refunds, broadcasts, and notification delivery. Capture query plans and logs.
7. Only after sign-off, repeat the snapshot/preflight/status/deploy/validate sequence for production during a maintenance window.

### Rollback

- Preferred rollback is provider snapshot/point-in-time restore after stopping application and workers.
- Because Phase 2C is additive, a forward fix is often safer once traffic has written to new tables.
- Do not use `prisma migrate resolve --rolled-back` unless the SQL changes were actually reversed and verified.
- Do not drop Phase 2C objects after they contain production writes without an export, dependency review, and approved rollback script.

## 7. Complete API inventory and control matrix

Authentication abbreviations: `Public`, `Auth`, `Super`, `AcademyAdmin`, `Student`, `Signed webhook`. All JSON mutations use strict Zod schemas unless stated otherwise. All paged list limits are at most 100; non-paged internal collections now have explicit caps.

| Mounted family | Concrete endpoints | Purpose | Auth/authz | Tenant rule | Paging / principal validation | Primary service | Expected errors | Test evidence |
|---|---:|---|---|---|---|---|---|---|
| `/health` | 2 | liveness/readiness | Public | none | none | health/Prisma | 200/503 | runtime smoke; live DB not run |
| `/api/auth` | 6 | login/register/Google/refresh/logout/session | Public or Auth | user session | strict body; auth-specific limiter | auth service | 400/401/403/409/429/503 | primitive attacks; DB flows pending |
| `/api/admin` core | 12 | overview, users, roles/status/sessions, orders/refunds/cancel, audit/security | Super + per-route permission | global | pages 1–100; UUID/filter/date schemas; idempotency on refund | admin service | 400/401/403/404/409/502 | mount boundary; DB pending |
| `/api/admin` domains | 21 | academies/admins, packages, coupons, entitlements | Super | global or explicit target academy | pages 1–100; arrays capped at 1,000 | admin domain service | 400/401/403/404/409 | mount boundary; DB pending |
| `/api/admin/broadcasts` | 14 | global broadcast/media lifecycle and delivery queue | Super | platform plus validated academy targets | paged; image 10 MB; targets explicit/capped | broadcast/media/job services | 400/401/403/404/409/503 | mount/provider primitives; DB pending |
| `/api/admin/content` | 20 | content/folder/upload/media/store/location/copy lifecycle | Super | global; course parent validated | pages 1–100; 500 MB content; copy 5,000 nodes | content/storage/job services | 400/401/403/404/409/503 | mount/upload attacks; DB pending |
| `/api/admin/questions` | 12 | taxonomy, question CRUD/clone/lifecycle | Super | platform (`academyId IS NULL`) | pages 1–100; max 50 subs/6 options | question service | 400/401/403/404/409 | shape/security tests; DB pending |
| `/api/academy` core/broadcasts | 27 | context, dashboard, students, enrollments, courses, broadcasts/media | AcademyAdmin | explicit active header membership | pages 1–100; strict UUID/body; media caps | academy admin/broadcast/media | 400/401/403/404/409/503 | tenant assertions; DB pending |
| `/api/academy/admissions` | 8 | import, QR generation, codes | AcademyAdmin | current academy only | import max 1,000; code max use bound | admissions service | 400/401/403/404/409/410 | suite present; DB writes skipped |
| `/api/academy/analytics` | 5 | overview/students/admissions/courses/content metrics | AcademyAdmin | current academy only | named/date ranges; oversized custom range rejected | analytics service | 400/401/403 | range tests; DB pending |
| `/api/academy/settings` | 5 | profile and verified logo upload | AcademyAdmin | current academy only | strict profile; JPEG/PNG/WebP ≤5 MB | settings/storage | 400/401/403/404/409/503 | suite present; provider/DB pending |
| `/api/academy/notifications` | 13 | templates, notification CRUD/send/schedule/cancel | AcademyAdmin | current academy and current students/course | pages 1–50; individual max 1,000; audience 100,000; email 50,000 | notification/template/delivery/job | 400/401/403/404/409/422/503 | suite present; DB/provider pending |
| `/api/academy/content` | 20 | tenant content/storage lifecycle | AcademyAdmin | current academy course/content | same shared content controls | content/storage/job | 400/401/403/404/409/503 | tenant/mount/upload tests; DB pending |
| `/api/academy/questions` | 12 | tenant taxonomy/question lifecycle | AcademyAdmin | current academy course/question | same shared question controls | question service | 400/401/403/404/409 | tenant/shape tests; DB pending |
| `/api/student` core | 12 | profile, academy preference/dashboard, courses/content access, orders | Student | self + active membership/enrollment/entitlement | order pages 1–100; bounded nonpaged lists | student/storage service | 400/401/403/404/503 | mount boundary; DB pending |
| `/api/student/admissions` | 2 | claim QR/code | Student | self identity from auth; academy derived from signed token/code | strict token/code | admissions service | 400/401/403/404/409/410 | mount boundary; DB pending |
| `/api/student/notifications` | 3 | inbox/unread/read | Student | recipient user ID from auth | pages 1–50 | notification service | 400/401/403/404 | mount boundary; DB pending |
| `/api/catalog` | 3 | public course/package catalog | Public | active academy/course/package only | pages 1–100; nested caps | public service | 400/404 | mount + catalog integration pending DB |
| `/api/contact` | 1 | contact submission and queued email | Public | optional active academy | strict body + honeypot + 5/hour local limiter | public/job/email | 202/400/404/429/503 | validation boundary; DB/provider pending |
| `/api/checkout` | 1 | priced checkout | Auth | authenticated buyer; resources derive server-side | 1–50 packages; required idempotency key | commerce/payment | 400/401/404/409/502/503 | mount/provider primitive; DB pending |
| `/api/payments/webhook/:provider` | 1 | verified payment events | Signed webhook | order derived from verified provider payment ID | raw ≤256 KB; HMAC; persisted event ID/hash | commerce/payment | 400/404/409/202 | signature tamper test; concurrency pending |

### Expanded route list

- Health: `GET /health/live`, `GET /health/ready`.
- Auth: `POST /api/auth/login|register|google|refresh|logout`, `GET /api/auth/session`.
- Admin core: `GET /overview|students|students/:userId|orders|orders/:orderId|audit|security-events`; `PATCH /students/:userId/role|status`; `POST /students/:userId/sessions/revoke|orders/:orderId/refund|cancel`.
- Admin academies: `GET,POST /academies`; `GET,PATCH /academies/:academyId`; `POST /academies/:academyId/suspend|restore|delete|admins/invite`; `POST /academies/:academyId/admins/:userId/revoke`.
- Admin packages/coupons/entitlements: `GET,POST /packages`; `GET,PATCH,DELETE /packages/:packageId`; `POST /packages/:packageId/restore`; `GET,POST /coupons`; `PATCH /coupons/:couponId`; `GET,POST /entitlements`; `POST /entitlements/:entitlementId/revoke`.
- Broadcasts under `/api/admin/broadcasts` and tenant equivalents under `/api/academy/broadcasts`: list/create/detail/update; publish/schedule/cancel/archive/restore/delete; image upload-intent/finalize/read/delete.
- Shared content under `/api/{admin|academy}/content`: list, folder create, upload-intent, finalize, location read/update, item read/update/archive/restore/move/copy, download/preview, sample-image intent/finalize/delete, store-section create/update/delete.
- Shared questions under `/api/{admin|academy}/questions`: taxonomy read/create/update/delete; question list/create/read/replace/clone/archive/restore/publish.
- Academy core: context/overview; student list/detail/invite/status/enrollment; course list/detail/create/update/archive/restore.
- Academy admissions: import validate/confirm/list/detail; QR session; code list/create/revoke.
- Academy analytics: overview/students/admissions/courses/content.
- Academy settings: read/update; logo intent/finalize/read.
- Academy notifications: template list/create/update/delete/preview; notification list/create/read/update/send/schedule/cancel/delete.
- Student: profile read/update; memberships; active-academy read/update; dashboard; course list/detail/content; content access; order list/detail; admission QR/code claims; notification list/unread/read.
- Public/commerce: catalog list/course/package, contact submit, checkout, payment webhook.

No router is currently orphaned. The duplicate Academy question handlers discovered during this audit were removed.

## 8. Storage and content security

Positive controls:

- Random, tenant/course-prefixed object keys; normalized and encoded filenames.
- Intent rows bind actor, academy/course, size, MIME, SHA-256, purpose, expiry, and status.
- Finalization re-reads provider metadata and requires exact size/MIME/checksum agreement before creating content.
- Finalization is compare-and-swap/idempotent. Signed download URLs are short-lived.
- Filename extension/MIME agreement is now enforced and encoded traversal is rejected.
- SVG is rejected. General content is capped at 500 MB; images at 5/10 MB.
- Disabled providers fail with a controlled 503 rather than fake success.

Remaining risks:

- **P1:** provider metadata verification is not magic-byte/content scanning. Add quarantine plus malware/type inspection before making objects accessible.
- **P1:** abandoned/expired upload objects and replaced/deleted media need a scheduled garbage collector with retention and audit logging.
- **P1:** direct object upload can consume storage before finalization rejects a mismatch; enforce provider-side content-length and lifecycle expiration.
- **P2:** test CDN/content-disposition behavior to ensure risky formats never execute in the application origin.

## 9. Commerce and payment security

Positive controls:

- Package availability and all prices/discounts are derived server-side.
- Checkout and refund require idempotency keys persisted under unique constraints.
- Coupon capacity uses a compare-and-swap increment in a serializable transaction and is reversed if checkout-provider creation fails.
- Zero-total orders grant access only after a verified server-side calculation.
- Webhook provider name, raw-body HMAC, event ID, payload hash, payment identity, and persisted replay state are checked.
- Entitlements are granted only on successful/complimentary orders. Late success/failure cannot alter cancelled/refunded orders after this audit fix.
- Refund calls use provider idempotency and persisted unique refund records.

Remaining risks:

- **P0 evidence gate:** run concurrent duplicate checkout, coupon last-use, webhook same/different payload, late success, failure-after-success, cancellation, and refund replay tests against PostgreSQL.
- **P1:** simultaneous delivery of the same new webhook event can still produce a transient unique/serialization error for one caller. The event remains protected from duplicate grants, but the HTTP retry behavior should be proven and optionally made explicitly claim-based.
- **P1:** add periodic provider reconciliation for orders/payments/refunds and alert on mismatches.
- **P1:** formalize currency/minor-unit handling before supporting currencies other than the current INR path.

## 10. Notifications, broadcasts, and durable jobs

Broadcast publication creates durable notification-send jobs in the same transaction. Notifications persist explicit audiences, delivery attempts, idempotency keys, provider IDs, retry fields, and audit records. Scheduled work has deduplication keys, attempts, exponential backoff, locks, stale recovery, and terminal failure states.

The worker race found in this audit was fixed: completion/failure updates are lease-owner compare-and-swap operations, stale recovery uses each job's own attempt budget, and cancellation is not overwritten.

Remaining risks:

- **P1:** there is no production worker supervisor/deployment manifest, leader election, heartbeat/lease renewal, graceful shutdown protocol, or dead-letter administration API.
- **P1:** cancelling a job already executing cannot reverse an external side effect; handlers must remain idempotent and eventually add cooperative cancellation checks.
- **P1:** email delivery is sequential and can be long-running. Move provider calls to per-recipient/batch jobs with provider-aware concurrency and backpressure.
- **P1:** platform broadcast fan-out loops through academies in one transaction. It is capped at 10,000 but should become batched jobs before that scale.
- **P2:** define retry/retention policies for failed notification deliveries, contact email, object cleanup, webhook reconciliation, and expired idempotency records.

## 11. Audit, observability, performance, and error safety

Audit/security APIs are Super Admin-only, filtered, cursor/page bounded, and return selected security fields. Mutating services commonly write actor, academy, action, entity type/ID, description, and sometimes before/after/metadata.

Gaps:

- **P1:** audit coverage is not complete for every important mutation. Examples include notification template update/delete, taxonomy update/delete, content store-section mutations, profile/preference changes, and some legacy Academy mutations. Standardize a transaction-aware audit helper and require before/after where meaningful.
- **P1:** audit retention, immutability/export, redaction, access review, and tamper monitoring are undefined.
- **P1:** several high-cardinality operations have caps but no continuation token; silent truncation is possible for memberships/courses/content at extreme scale. Convert these to pagination.
- **P1:** N+1/sequential behavior remains in broadcast academy fan-out, email delivery, content-tree object copies, and entitlement grants.
- **P1:** capture `EXPLAIN (ANALYZE, BUFFERS)` for audit, notification recipients, student entitlement/content, order filters, and analytics queries against production-like volume.
- **P2:** structured logs exist with request IDs and durations, but metrics/traces, queue depth, oldest-job age, provider latency, error budgets, and alerts do not.

No unsafe stack trace or secret echo was found in API error responses. Provider errors are reduced to controlled client messages, though selected truncated provider errors are retained internally for operations.

## 12. Frontend compatibility review (read-only)

This is a release blocker for the full product, not a request to modify frontend in this phase.

| Finding | Severity | Evidence / required future correction |
|---|---|---|
| Authentication is still mocked in `src/services/auth.service.ts`; Google claims are browser-decoded and mock JWT strings are generated. | P0 full-product | Replace with `/api/auth/login|google|register|refresh|logout|session`; use backend roles/permissions only. |
| Academy/settings/analytics/admissions and student calls do not consistently send `Authorization: Bearer ...`. | P0 full-product | Introduce one API client with bearer token, refresh, error envelope, and `x-academy-id`. |
| Student admission calls use `/api/academy/admissions/codes/claim` and `/qr/claim`; backend routes are `/api/student/admissions/...`. Bodies also send `studentUserId`, which backend correctly rejects/ignores by strict schema. | P0 full-product | Correct URLs and derive identity only from auth. |
| Logo UI calls one-step `POST /api/academy/settings/logo` with `{mimeType,size,...}`. Backend requires upload intent, direct object PUT, then finalize with `{uploadId}`. | P1 | Implement the three-step contract and obtain the read URL separately. |
| Academy/Admin stores and repositories remain largely in-memory mocks with offline success fallbacks. | P0 full-product | Replace mocks/fallback writes with real API adapters before claiming integration. |
| Vite has no `/api` development proxy and `VITE_API_BASE_URL` is declared but not consistently used. | P1 | Configure explicit environment-aware API base/proxy. |
| Frontend commonly reads `data.error` as a string, while backend uses a structured error envelope. | P1 | Normalize `{error:{code,message,details?},requestId}` centrally. |

Backend public catalog responses intentionally omit storage paths and correct answers. Student routes expose no question-answer bank, so no correct-answer leakage was found.

## 13. Verification results

| Command/check | Result |
|---|---|
| `npm install` | PASS; postinstall Prisma Client generation succeeded |
| Prisma schema format/validate/generate | PASS (final run recorded below) |
| TypeScript `typecheck` | PASS |
| Unit/security test command | PASS, 18/18 after new tests |
| Broad test command | PASS, 23 Node tests plus 13 tenant assertions; DB-writing suites reported skipped due missing safe DB |
| Integration command | SAFE SKIP, 0 pass / 3 skipped because no guarded test DB was configured |
| Build | PASS (final run recorded below) |
| Static mass-assignment/TS suppression scan | PASS; no direct request-body writes, `@ts-ignore`, `@ts-nocheck`, or `as any` in backend source |
| Unbounded-read scan | Confirmed findings were capped; remaining bounded-ID queries are constrained by validated input arrays |
| `npm audit` | FAIL release policy: 3 high, 0 critical; all trace to Prisma → `@prisma/config` → `deepmerge-ts <8` (GHSA-ggr8-5vv4-36mx) |
| `npm outdated --json` | INCONCLUSIVE; registry query did not complete in the restricted environment and was terminated |

The audit fix offered by npm is Prisma `6.12.0`, a breaking downgrade from `7.9.1`; `npm audit fix --force` was deliberately not run. Track a patched Prisma release or perform a separately reviewed version change. The vulnerable merge path is primarily a build/configuration dependency, which reduces direct HTTP exploitability but does not make a high advisory acceptable without ownership and a deadline.

## 14. Prioritized release gates

### P0 — must close before production

1. Reconcile the real production `_prisma_migrations` ledger and schema; prove notification and Phase 2C deployment state.
2. Run preflight, clean install migration, upgrade migration, constraint validation, and rollback restore on a staging clone.
3. Run the full isolated database suite, including real login/refresh/logout, RBAC, tenant A/B IDOR, mass assignment, storage finalize, checkout/coupon/webhook/refund concurrency, job recovery/cancellation, questions/taxonomy, broadcasts/notifications, audit, and public endpoints.
4. Resolve or formally time-bound the three high dependency findings with compensating controls and security ownership.
5. For the full product release, replace frontend mock auth/repositories and correct bearer, tenant, admission, error-envelope, and logo contracts.

### P1 — required for robust production operations

1. Distributed/edge rate limiting and abuse controls.
2. Worker supervision, heartbeat/lease policy, graceful shutdown, dead-letter operations, cleanup/reconciliation jobs, and queue metrics.
3. Malware/type inspection and orphan-object lifecycle cleanup.
4. Complete transactional audit coverage plus retention/tamper policy.
5. Provider sandbox E2E, reconciliation, timeouts, circuit breakers, and alerting.
6. Paginate currently capped collections and batch sequential fan-out/copy/email operations.
7. Production-like query-plan/load testing and missing-index remediation based on measured plans.

### P2 — hardening and maturity

1. OpenTelemetry traces, metrics dashboards, SLOs, and anomaly/security alerts.
2. Password recovery and expanded account-security workflows.
3. Formal data retention/deletion, privacy export, disaster recovery, and incident runbooks.

## 15. Final statement

The backend foundation and domain surface are coherent, mounted, and materially hardened. Local evidence supports moving to a controlled staging rehearsal. It does **not** support a production-ready claim until the migration ledger, disposable-database integration suite, provider behavior, dependency advisory, operational worker/rate-limit controls, and full-product frontend contract are proven.
