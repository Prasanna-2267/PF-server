# Parallax Flow — Phase 4 Staging Verification Report

Date: 2026-08-22  
Scope: backend-only local staging rehearsal, PostgreSQL integration, security, concurrency, integrity, and regression verification  

This report supersedes the earlier environment-blocked version. The complete migration chain and backend integration suites now pass against a disposable local PostgreSQL 16 database. No Supabase, production, staging, or unknown remote database was contacted.

## 1. Safety and environment

| Item | Actual evidence | Result |
|---|---|---|
| Docker | `docker info` returned Docker Desktop 29.6.1, Linux containers, x86_64 | PASS |
| Container | `pf-phase4-postgres`, official `postgres:16` image | PASS |
| Network | Published only as `127.0.0.1:55432 -> 5432` | PASS |
| Database | `parallax_flow_test` | PASS |
| User | `pf_test` | PASS |
| Credential | Newly generated random test-only password; not printed, committed, or written to an env file | PASS |
| Runtime URLs | `TEST_DATABASE_URL`, `DATABASE_URL`, and `DIRECT_URL` were identical loopback URLs | PASS |
| Explicit opt-in | `RUN_BACKEND_INTEGRATION=1` | PASS |
| Existing `server/.env` | Not used; its remote database values were never connected | PASS |
| Frontend | No frontend file was modified during Phase 4 work | PASS |

The integration guard rejected any non-loopback database, database name without a delimited test marker, URL mismatch, or missing opt-in. Destructive database cleanup was limited to the guarded disposable database.

## 2. Migration verification

The disposable database was created empty and the complete chain of 17 Prisma migrations applied successfully in chronological order, from `20260818000000_auth_users_foundation` through `20260821120000_phase_2c_operational_reliability`.

Evidence:

- clean-from-zero `prisma migrate deploy`: PASS;
- migration ledger: 17 finished, zero unfinished, zero rolled back;
- repeat deploy: “No pending migrations to apply”;
- Phase 2C operational tables present: `BackgroundJob`, `StorageUpload`, `IdempotencyRecord`, and `PaymentWebhookEvent`;
- `ContentItem_kind_storage_check` validated successfully;
- `QuestionOption_single_parent_check` validated successfully;
- zero remaining unvalidated constraints after the rehearsal.

The separate pre-Phase-2C upgrade preflight was not run against this empty database because it is designed for an already-migrated staging clone. It remains mandatory before applying Phase 2C to a real clone that currently stops at the prior migration.

## 3. Deterministic seed verification

The auth foundation seed was executed twice during every guarded preparation run. Both executions succeeded without duplicates or drift.

Verified persisted foundation:

- global roles `super_admin`, `admin`, and `student` exist exactly once;
- the Super Admin role has the approved permission set;
- role-permission seeding is idempotent;
- no secret or privileged user credential is seeded.

## 4. Automated test evidence

| Command | Database mode | Final result |
|---|---|---|
| `npm.cmd test` | Non-database/unit and runtime boundary suites | 18/18 PASS, 0 skipped |
| `npm.cmd run test:all` | All four database flags enabled against the disposable DB | 23/23 Node entries PASS, 0 skipped |
| `npm.cmd run test:integration:full` | Guarded prepare plus all unit/domain/integration files, serial execution | 36/36 Node entries PASS, 0 skipped |
| `npm.cmd run typecheck` | TypeScript no-emit | PASS |
| `npm.cmd run build` | Prisma generate plus production TypeScript build | PASS |

The final full integration run completed in approximately 58.8 seconds. Its domain suites included 34 admissions assertions, 24 analytics assertions, 13 tenant assertions, 16 notification assertions, 19 settings assertions, and 10 expanded Phase 4 PostgreSQL scenarios.

## 5. Authentication and session security

Status: **VERIFIED on local PostgreSQL**.

Verified:

- password login success and failure;
- persisted login and session security events;
- signed access tokens and opaque hashed refresh tokens;
- malformed, forged, expired, future-issued, wrong issuer/audience, and algorithm-confusion token rejection;
- simultaneous refresh-token use produces exactly one successful rotation;
- replayed refresh token is rejected;
- disabled users cannot refresh;
- logout returns 204, revokes the persisted session, invalidates the access token, and invalidates its refresh token;
- live global-role changes take effect on an already-issued access token because middleware reloads the current role from PostgreSQL;
- disabled/deleted/inactive-user and inactive-role checks fail closed.

Google authentication with a real Google identity was not exercised. The unconfigured-provider and invalid-credential boundaries remain covered, but a real Google sandbox flow is **UNVERIFIED**.

## 6. RBAC, tenant isolation, IDOR, and mass assignment

Status: **VERIFIED for the tested backend surface**.

Verified:

- anonymous access to every mounted protected domain returns 401;
- non-Super Admin access to Super Admin routes returns 403;
- Student access to Academy Admin routes returns 403;
- active Academy Admin membership is required;
- header, query, body, and foreign-resource academy spoofing fail closed;
- foreign course/content/question/admission/notification resource access is denied or hidden;
- multiple active academy memberships without `x-academy-id` return 409 rather than selecting an arbitrary tenant;
- explicit authorized academy selection succeeds;
- settings mass-assignment attempts for `status`, `revenue`, counters, slug, and deletion fields are rejected and persisted values remain unchanged;
- no tested cross-tenant IDOR or mass-assignment path succeeded.

## 7. Admissions

Status: **VERIFIED on local PostgreSQL**.

Verified:

- import validation, duplicate detection, existing-user handling, formula-injection sanitization, 1,000-row bound, confirmation, and tenant scoping;
- QR generation, expiry, invalid input, authentication, one-time replay rejection, academy binding, and already-admitted behavior;
- admission-code format, expiry, revocation, global uniqueness, capacity, already-admitted behavior, and audit logging;
- two simultaneous claims for the final capacity slot result in exactly one membership and one use increment;
- a claim for a nonexistent student rolls back without incrementing the code;
- inactive academy and missing-tenant paths fail closed.

## 8. Academy settings and analytics

Status: **VERIFIED on local PostgreSQL**.

Settings evidence covers GET/PATCH, tenant binding, email conflicts, email/phone/URL validation, optimistic update input, mass assignment, audit creation, and controlled 503 behavior when durable storage is disabled.

Analytics evidence covers student/course/content/admission/broadcast aggregation, zero-data and divide-by-zero handling, date ranges, 365-day bounds, tenant isolation, soft-delete/status filtering, bounded results, and sensitive-field non-disclosure.

## 9. Content and storage

Status: **VERIFIED with an in-process provider fake; real object storage UNVERIFIED**.

Verified:

- disabled storage returns controlled `STORAGE_PROVIDER_NOT_CONFIGURED`;
- upload intent validates filename, MIME type, size, and SHA-256 metadata;
- finalize verifies provider metadata before persistence;
- mismatched metadata is rejected;
- upload ownership and academy scope are enforced;
- signed download URLs contain no storage credentials;
- folder creation, file finalize, file copy, archive, restore, and foreign-tenant denial;
- traversal, active SVG, extension/MIME mismatch, and unsafe upload inputs are rejected;
- database content-kind/storage constraints are validated.

Not fully exercised:

- real S3-compatible PUT/HEAD/GET/delete behavior, CDN headers, malware scanning, and lifecycle cleanup;
- production-scale recursive tree copies and cancellation during an external object copy.

## 10. Questions and taxonomy

Status: **VERIFIED on local PostgreSQL for core lifecycle**.

Verified:

- taxonomy subject/chapter creation and course ownership;
- MCQ create, complete answer-structure replacement, clone, publish, archive, and restore;
- rich-text persistence strips executable markup;
- foreign-tenant question and course references are rejected;
- question-option parent constraint is validated;
- unit coverage for case MCQ and case descriptive answer-shape rules.

Production-volume case trees and every taxonomy delete dependency combination were not load-tested.

## 11. Broadcasts, notifications, templates, and jobs

Status: **VERIFIED for academy delivery and durable worker semantics; external operations remain partial**.

Verified:

- academy broadcast draft, publish, schedule, cancellation, audit, and notification job creation;
- audience expansion uses active academy students only;
- notification recipient uniqueness and tenant isolation;
- scheduled dispatch atomic claim, read idempotency, cancellation, and immutable sent state;
- notification template create, tenant-scoped preview substitution, and foreign-tenant denial;
- in-app and fake-email delivery records, provider message IDs, and idempotency keys;
- job deduplication, atomic claim, completion, stale lease recovery, retry exhaustion, and cancellation state;
- worker execution through `runDueJobsOnce`.

Unverified operational items:

- a production worker supervisor, leader election, heartbeat/lease renewal, graceful shutdown, and dead-letter administration;
- real email-provider delivery and bounce/webhook handling;
- platform-wide fan-out at production volume and cancellation after an irreversible provider side effect.

## 12. Commerce, payments, webhooks, refunds, and entitlements

Status: **VERIFIED with an in-process payment provider fake; real payment sandbox UNVERIFIED**.

Verified:

- server-side package pricing and published-item validation;
- checkout idempotency replay and conflicting-key rejection;
- zero-total checkout and entitlement creation;
- final-use coupon concurrency allows exactly one redemption and one usage increment;
- webhook signature rejection;
- concurrent delivery of the same verified event is claimed once;
- event replay is idempotent and cannot create duplicate entitlements;
- provider event ID reuse with conflicting content is rejected;
- payment success creates exactly one resource entitlement;
- refund idempotency and entitlement revocation;
- database resource-XOR enforcement for entitlements.

Defects found and fixed here are listed in section 18. Provider reconciliation, real settlement/refund behavior, chargebacks, and real payment-sandbox webhook ordering remain **UNVERIFIED**.

## 13. Super Admin and Student APIs

Status: **PARTIALLY VERIFIED on local PostgreSQL**.

Super Admin evidence includes outer permission enforcement, overview aggregation, user/session access, package and coupon creation, order/refund paths, entitlement grant/revoke, and recursively redacted audit reads. All Super Admin route groups are mounted behind authentication and the Super Admin role boundary.

Student evidence includes profile/session authentication, memberships, active-academy selection, multi-tenant denial, dashboard aggregation, enrolled-course listing, orders, admissions, and notifications.

Every mutation permutation of academy/admin/package/taxonomy/content/broadcast governance and every Student response at production data volume was not exhaustively replayed. Those are not assumed to pass beyond the tested service and route boundaries.

## 14. Public APIs

Status: **VERIFIED for persistence and visibility; distributed abuse controls UNVERIFIED**.

Verified:

- public catalog returns only active academy courses and published packages;
- unpublished, archived, deleted, and private storage fields are not exposed by tested responses;
- pagination and validation boundaries;
- contact validation and PostgreSQL persistence;
- contact IP address is stored only as an HMAC, not plaintext;
- contact delivery is queued as a durable job;
- honeypot and controlled-error boundaries exist.

The in-memory contact rate limiter was not tested across replicas and cannot provide distributed enforcement. A shared edge/Redis limiter remains required for multi-instance deployment.

## 15. Audit logging and security review

Status: **VERIFIED for tested mutations; coverage is not universal**.

Verified persisted audit events include actor, academy, entity, action, description, timestamp, and before/after data where implemented. Audit API output recursively redacts password, secret, token, authorization, cookie, API-key, credential, and signature keys.

No confirmed P0 authentication, RBAC, tenant-isolation, mass-assignment, webhook replay, coupon-capacity, admission-capacity, or entitlement-integrity defect remains in the tested backend surface.

Remaining security/operations risks:

- rate limiting is process-local;
- provider calls lack comprehensive timeout, circuit-breaker, and reconciliation controls;
- audit coverage, retention, immutability/export, and tamper monitoring are not universal;
- worker supervision and dead-letter operations are not deployed;
- real third-party provider behavior is unverified;
- the PostgreSQL adapter emitted a `pg` deprecation warning during concurrent query activity; compatibility must be tracked before the next major `pg` upgrade.

## 16. Database integrity and performance

Status: **VERIFIED for the disposable fixture scale; production-scale performance UNVERIFIED**.

Integrity queries returned zero violations for:

- memberships without academies or users;
- notification-recipient academy mismatches;
- order subtotal/discount/total mismatches;
- background-job status/lock mismatches;
- unvalidated constraints.

Representative `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` queries completed for academy-scoped audit history and student unread-notification access. This proves valid executable plans and indexes at fixture scale, not production latency or cardinality. Production-like volume, concurrent load, memory, vacuum behavior, and slow-query thresholds remain **UNVERIFIED**.

## 17. Dependency audit

`npm.cmd audit --json` completed and returned a nonzero exit because it found:

- 0 critical;
- 3 high;
- 0 moderate;
- 0 low.

All three entries are one dependency chain: `prisma` 7.9.1 -> `@prisma/config` -> `deepmerge-ts <8`, advisory GHSA-ggr8-5vv4-36mx (recursive-object stack exhaustion). npm offers only a breaking downgrade to Prisma 6.12.0. No forced audit fix or downgrade was applied.

Required before a production approval:

- named owner: **UNASSIGNED**;
- remediation deadline: **UNASSIGNED**;
- documented risk acceptance if no compatible patch exists: **MISSING**;
- continue monitoring for a compatible patched Prisma release.

The likely exposure is build/configuration-time merging of trusted Prisma configuration rather than a demonstrated HTTP request path, which reduces direct exposure but does not close the advisory.

## 18. Defects discovered and fixed

1. **Windows integration launcher:** direct spawning of `npx.cmd` failed. The harness now invokes the local Prisma and tsx CLI entrypoints with Node and fails on child-process errors.
2. **Unsafe test configuration inheritance:** the full runner now sets an explicit test-only signing secret and disables storage/email/payment configuration inherited from the host.
3. **Constraint rehearsal gap:** the two Phase 2C `NOT VALID` checks are now explicitly validated during guarded preparation.
4. **Seed evidence gap:** guarded preparation now runs the deterministic seed twice to prove idempotency.
5. **Admissions fixtures/contracts:** academies are explicitly active; QR replay tests reflect single-use security; expiry/required-code checks exercise valid service paths.
6. **Legacy disabled-storage contract:** academy logo behavior returns a controlled provider-disabled 503 instead of generating a fake path.
7. **Webhook first-delivery race:** provider events are now uniquely inserted, atomically claimed, and replayed without duplicate entitlement grants.
8. **Purchase entitlement integrity:** package purchases no longer also set `courseId`, satisfying the one-resource-only database constraint.
9. **Repeatable notification fixtures:** globally unique course names now include a run suffix, allowing repeated database regression runs.
10. **Windows shell deprecation/noise:** integration launchers no longer require `shell: true`.

All affected tests and the final full regression passed after these fixes.

## 19. Failed-test history

Initial and intermediate failures were retained as investigation evidence, not hidden:

- missing test-only `AUTH_JWT_SECRET` in the original runner;
- stale test message/status expectations after service hardening;
- inactive academy fixtures;
- expected contact validation status was 400 while the API correctly returned 422;
- unvalidated Phase 2C checks before the validation step;
- webhook concurrency and entitlement XOR defects;
- notification fixture name collision on a repeat run.

Final state: zero failing tests in the required regression commands.

## 20. Unverified staging and production gates

The following work requires external state or approvals and was not attempted:

1. positively identify and snapshot a restorable staging clone;
2. verify the staging migration ledger and schema drift;
3. run `phase-2c-preflight.sql` against a pre-Phase-2C staging clone;
4. deploy and validate migrations on that clone;
5. run authenticated staging smoke tests using staging-specific identities;
6. exercise snapshot restore/rollback on a separate rehearsal copy;
7. test real storage, email, Google, and payment sandboxes;
8. run production-like load and query-plan testing;
9. assign and resolve or formally accept the dependency advisory risk;
10. obtain database, backend, security, and operations sign-off.

No staging or production credential was available or requested, so these items are explicitly **UNVERIFIED**.

## 21. Staging migration runbook

1. Create a restorable clone/snapshot and positively verify project, host, database, branch, and ownership with two-person review.
2. Confirm the target is not production.
3. Compare `_prisma_migrations` with all 17 repository migrations and investigate any drift or failed row.
4. If the clone is pre-Phase-2C, run `prisma/phase-2c-preflight.sql`; require all violation queries to be empty and expected prior indexes to exist.
5. Run `prisma migrate deploy` against the approved clone.
6. Run `prisma/phase-2c-validate-constraints.sql` and the integrity queries from this report.
7. Run staging-specific authenticated smoke tests and provider-sandbox tests without destructive fixture resets.
8. Observe API, database, job, email, storage, and payment telemetry.
9. Rehearse restore/rollback separately.
10. Record named sign-offs and unresolved-risk ownership.

## 22. Final verdict

**STAGING MIGRATION READY**

The backend migration chain, deterministic seed, database constraints, security boundaries, concurrency controls, domain integration, integrity checks, type-check, and build pass on a disposable local PostgreSQL 16 database. The project may proceed to an approved staging-clone migration rehearsal. This verdict does not approve a production release and does not claim that an actual staging environment or real providers have been verified.
