import "dotenv/config";
import { prisma } from "../db/prisma.js";
import { logger } from "../observability/logger.js";
import { runDueJobsOnce } from "../services/backgroundJobService.js";
import { dispatchLearnerPushDeliveries, runLearnerReminderSweep } from "../services/learnerNotificationService.js";
import { processMonthlyReportsFor1stOfMonth } from "../services/monthlyReportService.js";

const parsePositiveInteger = (value: string | undefined, fallback: number, maximum: number) => {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`Expected an integer from 1 to ${maximum}, received ${value}.`);
  }
  return parsed;
};

const pollIntervalMs = parsePositiveInteger(process.env.JOB_WORKER_POLL_INTERVAL_MS, 5_000, 300_000);
const batchLimit = parsePositiveInteger(process.env.JOB_WORKER_BATCH_LIMIT, 50, 100);
const runOnce = process.env.JOB_WORKER_RUN_ONCE === "true";
const workerId = process.env.JOB_WORKER_ID?.trim() || `durable-worker-${process.pid}`;
const notificationMaintenanceMs = parsePositiveInteger(process.env.NOTIFICATION_MAINTENANCE_INTERVAL_MS, 300_000, 3_600_000);
const monthlyReportMaintenanceMs = parsePositiveInteger(process.env.MONTHLY_REPORT_MAINTENANCE_INTERVAL_MS, 21_600_000, 86_400_000);
let stopping = false;
let nextNotificationMaintenanceAt = 0;
let nextMonthlyReportMaintenanceAt = 0;

const stop = (signal: string) => {
  stopping = true;
  logger.info("durable_worker.stopping", { signal, workerId });
};

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

const wait = (durationMs: number) => new Promise<void>((resolve) => {
  let settled = false;
  let timer: NodeJS.Timeout;

  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    process.off("SIGINT", finish);
    process.off("SIGTERM", finish);
    resolve();
  };

  timer = setTimeout(finish, durationMs);
  process.once("SIGINT", finish);
  process.once("SIGTERM", finish);
});

async function runWorker() {
  logger.info("durable_worker.started", { workerId, pollIntervalMs, batchLimit, runOnce });
  do {
    try {
      const results = await runDueJobsOnce({ workerId, limit: batchLimit });
      if (Date.now() >= nextNotificationMaintenanceAt) {
        const [reminders, pushes] = await Promise.all([runLearnerReminderSweep(), dispatchLearnerPushDeliveries()]);
        nextNotificationMaintenanceAt = Date.now() + notificationMaintenanceMs;
        logger.info("durable_worker.notification_maintenance", { workerId, reminders, pushes });
      }
      if (Date.now() >= nextMonthlyReportMaintenanceAt) {
        const monthlyReports = await processMonthlyReportsFor1stOfMonth();
        nextMonthlyReportMaintenanceAt = Date.now() + monthlyReportMaintenanceMs;
        logger.info("durable_worker.monthly_report_maintenance", { workerId, monthlyReports });
      }
      logger.info("durable_worker.cycle", {
        workerId,
        claimed: results.length,
        completed: results.filter((result) => result.status === "COMPLETED").length,
        retried: results.filter((result) => result.status === "RETRY_SCHEDULED").length,
        failed: results.filter((result) => result.status === "FAILED").length,
        leaseLost: results.filter((result) => result.status === "CANCELLED_OR_LEASE_LOST").length,
      });
    } catch (error) {
      logger.error("durable_worker.cycle_failed", error, { workerId });
      if (runOnce) throw error;
    }
    if (!runOnce && !stopping) await wait(pollIntervalMs);
  } while (!runOnce && !stopping);
}

runWorker()
  .catch((error: unknown) => {
    logger.error("durable_worker.failed", error, { workerId });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    logger.info("durable_worker.stopped", { workerId });
  });
