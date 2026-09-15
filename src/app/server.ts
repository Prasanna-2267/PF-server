import { createServer, type Server } from "node:http";
import { getConfig } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../observability/logger.js";
import { createApp } from "./create-app.js";

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

export const startServer = async (): Promise<void> => {
  const config = getConfig();
  await prisma.$connect();
  const app = createApp(config);
  const server = createServer(app);
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("server.shutdown_started", { reason });
    const forceTimer = setTimeout(() => {
      logger.error("server.shutdown_timeout", undefined, { reason });
      server.closeAllConnections();
      process.exit(exitCode || 1);
    }, 10_000);
    forceTimer.unref();
    try {
      await closeServer(server);
      await prisma.$disconnect();
      clearTimeout(forceTimer);
      logger.info("server.shutdown_complete", { reason });
      process.exit(exitCode);
    } catch (error) {
      logger.error("server.shutdown_failed", error, { reason });
      process.exit(1);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT", 0));
  process.once("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.once("uncaughtException", (error) => {
    logger.error("process.uncaught_exception", error);
    void shutdown("uncaughtException", 1);
  });
  process.once("unhandledRejection", (error) => {
    logger.error("process.unhandled_rejection", error);
    void shutdown("unhandledRejection", 1);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.server.port, config.server.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  logger.info("server.started", {
    environment: config.environment,
    host: config.server.host,
    port: config.server.port,
  });
};
