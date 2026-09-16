# Server deployment handoff

This repository is the single Express/Prisma/PostgreSQL backend used by the web and mobile clients. A production deployment requires an API service and a separate durable-worker service using the same release image and environment.

## Release architecture

- API command: `npm start`
- Worker command: `npm run jobs:worker`
- API health: `GET /health/live` and `GET /health/ready`
- Container port: `4000`
- Runtime user: non-root `node`
- Database migrations: an explicit, one-off release job before application promotion

Do not run multiple ad-hoc schedulers in place of the durable worker. The worker delivers transactional email/notifications, scheduled broadcasts, and Monthly Reports.

## Required production configuration

Start from `.env.example` and supply real secrets through the deployment platform. At minimum configure:

- `NODE_ENV=production`, `HOST=0.0.0.0`, and `PORT=4000`;
- pooled `DATABASE_URL` and migration-safe `DIRECT_URL`;
- a unique 32+ character `AUTH_JWT_SECRET`;
- exact HTTPS `CORS_ALLOWED_ORIGINS` and `PUBLIC_APP_URL`;
- `TRUST_PROXY` for the hosting topology;
- the intended registration modes and matching Google client ID;
- S3/R2 storage credentials with `STORAGE_DRIVER=s3`;
- SMTP or HTTP email-provider credentials;
- the real payment provider/webhook credentials;
- Expo push credentials when enhanced push security is enabled;
- `FAKE_PAYMENT_ENABLED=false`.

Provider-backed production features intentionally return controlled errors when their provider is absent. Never replace missing provider configuration with fake success paths.

## Database release procedure

Never use `prisma db push`, reset, drop, truncate, or replace the shared database.

1. Take and verify a restorable database backup/snapshot.
2. Rehearse the exact release commit against a recent isolated production clone.
3. Review `prisma migrate status` and any documented preflight SQL results.
4. Run `npx prisma migrate deploy` once from a controlled release job that has the Prisma CLI and `DIRECT_URL`.
5. Re-run `prisma migrate status`; stop if any migration is failed or pending unexpectedly.
6. Promote the API image, wait for readiness, then promote the worker from the same image digest.

The minimal runtime image intentionally excludes development tooling, so migrations must not be improvised from the running API container.

## Artifact and release gate

```powershell
npm ci
npm run prisma:validate
npm run prisma:generate
npm run typecheck
npm test
npm run test:all
npm run build
docker build --tag parallax-flow-server:<immutable-version> .
```

Database integration tests must use only the guarded disposable test database described in the README. They must never point at staging or production.

## Post-deploy smoke checks

- `/health/live` and `/health/ready` return 200;
- API and worker logs show the same release version and no configuration errors;
- login, refresh, logout, tenant isolation, and RBAC checks succeed;
- a controlled storage upload/view succeeds;
- a controlled transactional email and push notification succeed;
- a payment-provider test event is accepted exactly once in the provider's approved test environment;
- worker leases/jobs progress without duplicate delivery;
- Store purchase entitlements appear in the mobile Library;
- a purchased Monthly Report completes through generation, storage, email, and app view-only access.

## Rollback

Promote the previous API and worker image together. Do not reverse a database migration unless a separately reviewed and tested reverse migration exists. If a migration is forward-only, keep the migrated database and roll back only to an application version proven compatible with it.
