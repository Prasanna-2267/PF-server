# PARALLAX FLOW — ACADEMY ADMIN RELEASE-READINESS FIX PASS

Date: 25 August 2026  
Environment: disposable local PostgreSQL 16 (`pf-phase4-postgres`, `parallax_flow_test`) and local API/UI only  
Production/Supabase access: none

## 1. FIXES COMPLETED

Status: PASS

- Student status mutations now invalidate both `['academy', academyId, 'students']` and `['academy', academyId, 'overview']`.
- Course create/update/archive/restore mutations now invalidate both `['academy', academyId, 'courses']` and `['academy', academyId, 'overview']`.
- Content create/update/delete/move/copy/finalize paths now invalidate content, content-folder, and Overview queries through the shared refresh path.
- Existing Admissions, Questions, and Broadcast mutation paths were rechecked and retain Overview invalidation.
- A production-safe, compiled, continuously polling durable-worker entry point was added. It supports bounded polling/batches, structured cycle telemetry, run-once smoke mode, and graceful shutdown.
- Production scripts now distinguish the development one-shot runner, compiled one-shot runner, and long-lived worker.
- The scheduled-broadcast integration test now races two workers and requires exactly one claim for the queued delivery job.
- No UI redesign was performed.

## 2. REMAINING BLOCKERS

Status: PARTIAL

- Live non-production Cloudflare R2: NOT VERIFIED. `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, and `R2_PUBLIC_BASE_URL` are absent from the active process; `server/.env` also has no R2 bucket entry. No external storage request was made.
- Browser rehearsal: NOT VERIFIED. The browser runtime reported zero connected browser sessions, so visual UI flows, hard-refresh behavior, and browser React Query isolation could not be exercised.
- Camera QR scanner: NOT IMPLEMENTED. The Student admission page explicitly renders a disabled `Camera Scanner Not Connected` control. The pasted-token fallback remains present.
- Durable worker deployment: NOT VERIFIED. The compiled command and production Docker image were verified locally, but no actual production/staging hosting target exists in the repository to prove a long-lived worker service is deployed and monitored.
- Google OAuth: NOT VERIFIED. Google client configuration is absent from the active environment.
- Build toolchain dependency audit: PARTIAL. Production dependency audits contain zero vulnerabilities, but the backend development/build dependency graph reports three high findings through `prisma -> @prisma/config -> deepmerge-ts` (GHSA-ggr8-5vv4-36mx). The advertised automatic fix is a major Prisma downgrade and was not applied during this focused pass.
- Final production load/security testing: NOT VERIFIED because the live R2, deployed-worker, browser, and authentication-environment gates are not all complete.

## 3. DATABASE STATUS

Status: PASS

- PostgreSQL 16 accepted connections on the disposable database.
- Prisma found 20 migrations and reported no pending migrations.
- The deterministic seed executed twice successfully.
- The full integration suite passed 54/54 tests with zero skips.
- Integrity queries returned zero violations for missing Academy/User membership relations, notification recipient tenant mismatch, order total mismatch, and background-job lock mismatch.
- Representative `EXPLAIN (ANALYZE, BUFFERS)` checks completed in the integration suite.

## 4. BACKEND STATUS

Status: PASS

- `/health/live` returned 200.
- `/health/ready` returned 200.
- Backend unit/security tests passed 31/31.
- Backend typecheck and production build passed.
- Full database integration passed 54/54 with zero failures, skips, or pending DDL.
- Academy CRUD/lifecycle coverage includes Admissions, Students, Courses, Content metadata, Questions/taxonomy, Broadcasts, notifications, and audit logging.

## 5. RBAC STATUS

Status: PASS

- Unauthenticated outer API boundaries returned 401.
- A live local Academy Admin login received 403 from `/api/admin/packages`.
- Student, Academy Admin, and Super Admin boundaries passed the full HTTP integration suite.
- Disabled account, wrong-role, and ambiguous multiple-Academy membership behavior fail closed in the integration suite.

## 6. TENANT ISOLATION STATUS

Status: PASS

- Academy A/B isolation passed for students, courses, content, questions, broadcasts, admissions, notifications, and analytics.
- Client-supplied Academy identifiers in headers, query strings, and bodies cannot override the authenticated tenant context.
- Cross-Academy IDOR attempts return controlled denial/not-found responses.
- Super Admin retains authorized cross-Academy access while direct platform academic APIs exclude Academy-owned records.

## 7. STORAGE STATUS

Status: PARTIAL

- PASS: object-key sanitization, signed upload intent construction, object verification before publication, short-lived signed download generation, safe deletion, PostgreSQL metadata lifecycle, hierarchy/copy behavior, and cross-tenant service authorization passed automated tests.
- NOT VERIFIED: real browser upload -> live non-production R2 -> metadata -> refresh -> authorized download -> URL expiry -> delete.
- NOT VERIFIED: real R2 rejection of Academy A signing/downloading/deleting Academy B objects.
- No production or unclassified storage was contacted.

## 8. CACHE/SYNC STATUS

Status: PARTIAL

- PASS: all confirmed Overview invalidation gaps for Students, Courses, and Content were corrected.
- PASS: Admissions, Questions, and Broadcasts retain Overview invalidation.
- PASS: frontend tests passed 129/129; frontend typecheck and production build passed.
- NOT VERIFIED: live browser mutation-to-Overview refresh and logout/identity-change cache isolation, because no controllable browser was connected.

## 9. WORKER STATUS

Status: PARTIAL

- PASS: `npm run jobs:worker` uses compiled JavaScript and runs as a long-lived poller by default.
- PASS: the production Docker image built successfully and the packaged worker command executed against the disposable database.
- PASS: scheduled broadcast publication, recipient creation, automatic delivery, retry scheduling, stale-lock recovery, terminal failed-job state, failure telemetry, and deduplication passed integration tests.
- PASS: two concurrent workers raced the same scheduled broadcast job; exactly one claimed and completed it.
- PASS: failed jobs are observable through `BackgroundJob.status`, `attemptCount`, `maxAttempts`, `lastError`, and structured worker logs.
- NOT VERIFIED: an actual non-production/production platform deployment running the worker continuously as a separately monitored service.

## 10. AUTHENTICATION STATUS

Status: PARTIAL

- PASS: live local Academy Admin password login.
- PASS: authenticated `/api/auth/session` restoration.
- PASS: refresh-token rotation and old-refresh replay rejection (401).
- PASS: logout and post-logout session rejection (401).
- PASS: wrong-password rejection (401).
- PASS: Academy context resolution and Academy Admin -> Super Admin boundary rejection (403).
- PASS: expired session, disabled account, wrong role, Academy A/B isolation, and multiple-membership fail-closed behavior in full integration.
- NOT VERIFIED: real browser hard refresh, browser cache clearing, and two simultaneous Academy Admin browser identities.
- NOT VERIFIED: Google OAuth, because it is not configured in this environment.

## 11. MODULE-BY-MODULE PASS/FAIL TABLE

| Module | API/backend | Authentication/RBAC/tenant | PostgreSQL CRUD/integrity | Frontend/cache | External/browser | Verdict |
|---|---|---|---|---|---|---|
| Overview | PASS | PASS | PASS | PASS | NOT VERIFIED | PARTIAL |
| Admissions | PASS | PASS | PASS | PASS | NOT IMPLEMENTED | PARTIAL |
| Students | PASS | PASS | PASS | PASS | NOT VERIFIED | PARTIAL |
| Courses | PASS | PASS | PASS | PASS | NOT VERIFIED | PARTIAL |
| Content | PASS | PASS | PASS | PASS | NOT VERIFIED | PARTIAL |
| Questions | PASS | PASS | PASS | PASS | NOT VERIFIED | PARTIAL |
| Broadcast | PASS | PASS | PASS | PASS | NOT VERIFIED | PARTIAL |

Admissions `NOT IMPLEMENTED` refers only to the camera scanner; server QR generation/rotation/claim and pasted-token fallback are implemented and verified. Content external/browser status refers to live R2 and browser verification. Broadcast external/browser status refers to the actual deployed long-lived worker and browser flow.

## 12. FINAL PRODUCTION READINESS VERDICT

Status: PARTIAL

The database, backend, RBAC, tenant isolation, deterministic migrations/seed, core CRUD lifecycles, cache invalidation implementation, QR server security, and durable-worker implementation pass the available automated and local API evidence. Production readiness is not established until a clearly non-production R2 environment completes the full storage chain, a real worker service is deployed and observed continuously, the camera scanner is implemented if required for release, two Academy Admin browser identities complete the authentication/cache rehearsal, the build-toolchain advisory is resolved or formally risk-accepted, and final security/load testing is executed.

### Evidence commands

- `npm.cmd test -- --run`
- `npm.cmd run typecheck`
- `npm.cmd run build`
- `npm.cmd test` (server)
- `npm.cmd run typecheck` (server)
- `npm.cmd run build` (server)
- `npm.cmd run test:integration:full` with `TEST_DATABASE_URL`, `DATABASE_URL`, and `DIRECT_URL` explicitly set to the disposable local PostgreSQL URL and `RUN_BACKEND_INTEGRATION=1`
- `npm.cmd run jobs:worker` with `JOB_WORKER_RUN_ONCE=true`
- `docker.exe build -t pf-release-readiness-worker .`
- Packaged Docker worker run with the disposable database and a non-production HTTPS CORS placeholder
- Local API calls to `/health/live`, `/health/ready`, `/api/auth/login`, `/api/auth/session`, `/api/auth/refresh`, `/api/auth/logout`, `/api/academy/context`, `/api/academy/admissions/qr`, and the forbidden `/api/admin/packages`
- Read-only PostgreSQL integrity and background-job observability queries through `psql`
- `npm.cmd audit --omit=dev --omit=optional --json` for frontend and backend production dependency graphs
