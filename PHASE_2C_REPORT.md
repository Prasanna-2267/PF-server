# Phase 2C backend completion report

## Implemented

- Runtime/authentication/authorization/tenant resolution/route mounting remain the foundation for all routes.
- Platform and academy content APIs: folders, list/detail, verified upload intents/finalize, signed preview/download, metadata, archive/restore, move, synchronous file copy, durable recursive folder copy, sample images, store sections, and location settings.
- Academy logo and academy/global broadcast images use the same verified storage provider.
- Super Admin: academy CRUD/lifecycle/admin invitations, packages and package items, coupons/targets, entitlements, users, sessions, orders, cancellations, refunds, audit, and security events.
- Platform and academy question banks: filters, detail, create, replace-update, clone, publish/archive/restore, rich-text sanitization, case sub-questions, answer options, and taxonomy CRUD with hierarchy checks.
- Academy and platform broadcasts: CRUD/lifecycle, scheduling/cancellation, audience expansion, in-app delivery, images, and durable jobs.
- Notifications: CRUD, targeting, in-app inbox/read state, templates/preview, delivery-attempt records, optional email channel, and scheduled dispatch.
- Public catalog/course/package detail, persisted/rate-limited contact intake, checkout, coupons, provider webhooks, receipts, entitlements, refunds, and student order history.
- Student profile, academy memberships/selection, dashboard, enrolled courses, content visibility, and entitlement-gated signed access.
- Durable operational models for jobs, uploads, idempotency, contact submissions, webhook replay protection, notification delivery, preferences, and refunds.
- Cursor/filter-capable audit and security APIs with recursive secret redaction.

## External prerequisites (honest non-completion states)

- No storage, email, or payment provider is enabled until real credentials are configured.
- The new migration has not been run against Supabase or any production database.
- Integration tests requiring PostgreSQL are present but remain skipped unless an explicitly isolated test database is supplied.

## Deployment gates

1. Inspect production migration history and take a backup.
2. Audit legacy rows against the new `NOT VALID` constraints and unique indexes.
3. Apply the migration in staging, run `npm run test:integration`, and exercise configured providers in sandbox accounts.
4. Validate constraints in staging, then follow the normal reviewed production migration process.

## Dependency audit residual

`npm audit` reports GHSA-ggr8-5vv4-36mx in `deepmerge-ts@7.1.5`, pinned by `@prisma/config@7.9.1`. The affected path is Prisma configuration/tooling; application requests do not accept or merge recursive configuration graphs. npm's offered remediation is a breaking Prisma downgrade to 6.12.0, while forcing `deepmerge-ts@8` would violate Prisma's exact dependency pin. No unsafe forced change was applied. Re-evaluate when Prisma publishes a compatible release containing `deepmerge-ts >=8`.
