import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const requestContext = (req: Request, res: Response, next: NextFunction): void => {
  const supplied = req.get("x-request-id")?.trim();
  req.requestId = supplied && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();
  res.setHeader("x-request-id", req.requestId);
  next();
};
