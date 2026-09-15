import "dotenv/config";
import { prisma } from "../db/prisma.js";
import { logger } from "../observability/logger.js";
import { runDueJobsOnce } from "../services/backgroundJobService.js";

runDueJobsOnce()
  .then((results) => logger.info("durable_jobs.completed", { claimed: results.length, completed: results.filter((result) => result.status === "COMPLETED").length, retried: results.filter((result) => result.status === "RETRY_SCHEDULED").length, failed: results.filter((result) => result.status === "FAILED").length }))
  .catch((error: unknown) => { logger.error("durable_jobs.failed", error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
