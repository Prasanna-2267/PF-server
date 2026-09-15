# Parallax Flow Backend

This directory is the standalone TypeScript/Express API. It does not import or depend on the frontend.

## Local verification

```powershell
npm install
npm run prisma:validate
npm run prisma:generate
npm run typecheck
npm test
npm run test:all
npm run build
```

Database integration tests are deliberately opt-in. Set `DATABASE_URL` and `TEST_DATABASE_URL` to the same isolated local/test database, set `RUN_BACKEND_INTEGRATION=1`, then run `npm run test:integration`. The safety guard rejects ordinary production-looking database names and remote hosts.

## Provider behavior

- Storage defaults to `disabled`. Set `STORAGE_DRIVER=s3` and all S3-compatible credentials to enable signed upload/download, copy, delete, and metadata verification.
- Email defaults to disabled. `EMAIL_WEBHOOK_URL` enables the HTTP email adapter.
- Payments default to disabled. `PAYMENT_CHECKOUT_URL` plus `PAYMENT_WEBHOOK_SECRET` enable checkout, signed webhooks, and refunds.
- Provider-dependent endpoints return a controlled `503` when their provider is absent. They never synthesize successful uploads, payments, refunds, or email deliveries.

## Durable jobs

Run `npm run jobs:worker` as a separate long-lived production process using the same image and database configuration as the API. The worker polls every five seconds by default; `JOB_WORKER_POLL_INTERVAL_MS` and `JOB_WORKER_BATCH_LIMIT` may tune the interval and batch size. It also reconciles purchased Monthly Report schedules every six hours by default (`MONTHLY_REPORT_MAINTENANCE_INTERVAL_MS`) so missed or pre-deployment purchase-month jobs are repaired safely. Set `JOB_WORKER_RUN_ONCE=true` only for deployment smoke checks. During local development, keep `npm run jobs:worker:dev` running beside `npm run dev`; development-only one-shot execution remains available through `npm run jobs:run-once:dev`.

To preview a purchased Monthly Report immediately in development without changing its month-end schedule, run `npm run reports:test-delivery -- --email registered@example.com`. Add `--month YYYY-MM` to select a particular purchased month. The command generates the report from that user's real data, writes a PDF under `.tmp/monthly-report-tests`, and sends the same PDF to the user's registered address through the configured email provider. It refuses to run when `NODE_ENV=production`.

Jobs use persisted leases, compare-and-set claims, retry backoff, stale-lock recovery, terminal failure states, and deduplication keys. Supported work includes new-account email, scheduled notifications, academy and global broadcasts, contact email, and recursive content copies. Deployments must run both the API command (`npm start`) and the worker command (`npm run jobs:worker`) as separate services.

New-account email is written to the durable outbox in the same transaction that creates the account, then delivered only after commit by the worker. Configure `PUBLIC_APP_URL`, optional `PUBLIC_LOGO_URL`, and `SUPPORT_EMAIL` together with the existing SMTP/HTTP email provider variables. `PUBLIC_LOGO_URL` defaults to the existing `/logo.png` public asset under `PUBLIC_APP_URL`. For a no-send HTML preview, run `npm run email:preview:account-created` and capture stdout in a local development file if desired.

## Migration warning

`prisma/migrations/20260821120000_phase_2c_operational_reliability/migration.sql` is local and has **not** been deployed. Verify the target database's migration history and legacy data before applying it. Several integrity constraints are marked `NOT VALID` intentionally: they protect new writes without falsely claiming existing production rows were inspected. Validate them only after a data audit.
