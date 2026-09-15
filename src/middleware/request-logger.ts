import { performance } from "node:perf_hooks";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../observability/logger.js";

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const startedAt = performance.now();

  res.once("finish", () => {
    const fields = {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl.split("?", 1)[0],
      statusCode: res.statusCode,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      userId: req.auth?.userId,
    };
    if (res.statusCode >= 500) logger.error("request.completed", undefined, fields);
    else if (res.statusCode >= 400) logger.warn("request.completed", fields);
    else logger.info("request.completed", fields);
  });

  next();
};
