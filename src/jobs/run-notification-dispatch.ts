import "dotenv/config";
import { prisma } from "../db/prisma.js";
import { logger } from "../observability/logger.js";
import { runScheduledNotificationsOnce } from "../services/academyNotificationService.js";

const run = async (): Promise<void> => {
  const results = await runScheduledNotificationsOnce();
  logger.info("notification_dispatch.completed", {
    claimed: results.length,
    dispatched: results.filter((result) => result.dispatched).length,
    failed: results.filter((result) => !result.dispatched).length,
  });
};

run()
  .catch((error: unknown) => {
    logger.error("notification_dispatch.failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
