import { Router } from "express";
import { prisma } from "../db/prisma.js";

const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("dependency timeout")), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export const healthRouter = Router();

healthRouter.get("/live", (_req, res) => {
  res.setHeader("cache-control", "no-store");
  res.json({ status: "ok" });
});

healthRouter.get("/ready", async (_req, res) => {
  res.setHeader("cache-control", "no-store");
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 2_000);
    res.json({ status: "ready" });
  } catch {
    res.status(503).json({ status: "not_ready" });
  }
});
