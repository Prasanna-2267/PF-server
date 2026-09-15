import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../errors/api-error.js";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

export const requireJsonContentType = (req: Request, _res: Response, next: NextFunction): void => {
  if (req.path.endsWith("/binary") || req.path.includes("/uploads/") && req.path.includes("/binary")) {
    next();
    return;
  }
  const rawContentLength = req.headers["content-length"];
  const contentLength = typeof rawContentLength === "string" ? Number(rawContentLength) : 0;
  const hasBody = req.headers["transfer-encoding"] !== undefined
    || (Number.isFinite(contentLength) && contentLength > 0);
  if (BODY_METHODS.has(req.method) && hasBody && !req.is(["application/json", "application/*+json"])) {
    next(new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "This endpoint accepts JSON request bodies only."));
    return;
  }
  next();
};
