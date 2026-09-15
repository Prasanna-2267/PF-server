import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../errors/api-error.js";

interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
  namespace: string;
}

interface Counter {
  count: number;
  resetAt: number;
}

export const createRateLimiter = ({ windowMs, maxRequests, namespace }: RateLimiterOptions) => {
  const counters = new Map<string, Counter>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    if (counters.size > 10_000) {
      for (const [key, value] of counters) if (value.resetAt <= now) counters.delete(key);
      if (counters.size > 10_000) counters.clear();
    }

    const key = `${namespace}:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
    const current = counters.get(key);
    const counter = !current || current.resetAt <= now
      ? { count: 1, resetAt: now + windowMs }
      : { count: current.count + 1, resetAt: current.resetAt };
    counters.set(key, counter);

    const remaining = Math.max(0, maxRequests - counter.count);
    res.setHeader("ratelimit-limit", String(maxRequests));
    res.setHeader("ratelimit-remaining", String(remaining));
    res.setHeader("ratelimit-reset", String(Math.ceil(counter.resetAt / 1000)));

    if (counter.count > maxRequests) {
      res.setHeader("retry-after", String(Math.max(1, Math.ceil((counter.resetAt - now) / 1000))));
      next(new ApiError(429, "RATE_LIMIT_EXCEEDED", "Too many requests. Try again later."));
      return;
    }

    next();
  };
};
