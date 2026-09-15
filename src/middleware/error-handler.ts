import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import { ApiError, type FieldErrors } from "../errors/api-error.js";
import { logger } from "../observability/logger.js";
import { StorageProviderError } from "../integrations/storage-provider.js";

const zodFieldErrors = (error: ZodError): FieldErrors => {
  const fields: FieldErrors = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "request";
    (fields[path] ??= []).push(issue.message);
  }
  return fields;
};

const mapError = (error: unknown): ApiError => {
  if (error instanceof ApiError) return error;
  if (error instanceof ZodError) {
    return new ApiError(422, "VALIDATION_FAILED", "The request contains invalid fields.", zodFieldErrors(error));
  }
  if (error instanceof StorageProviderError) {
    return new ApiError(
      503,
      "STORAGE_PROVIDER_UNAVAILABLE",
      "Object storage could not complete the request. Please try again shortly.",
    );
  }
  if (error instanceof SyntaxError && "body" in error) {
    return new ApiError(400, "MALFORMED_JSON", "The request body contains malformed JSON.");
  }
  if (error instanceof Error && "statusCode" in error) {
    const statusCode = Number((error as Error & { statusCode: unknown }).statusCode);
    if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
      return new ApiError(statusCode, "REQUEST_REJECTED", error.message);
    }
  }
  if (error instanceof Error) {
    const legacyStatus = /^(400|401|403|404|409|422)\b/.exec(error.message)?.[1];
    if (legacyStatus) return new ApiError(Number(legacyStatus), "REQUEST_REJECTED", error.message.replace(/^\d{3}\s+[^:]+:\s*/, ""));
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") return new ApiError(409, "RESOURCE_CONFLICT", "A resource with these values already exists.");
    if (error.code === "P2025") return new ApiError(404, "RESOURCE_NOT_FOUND", "The requested resource was not found.");
    if (error.code === "P2003") return new ApiError(409, "RESOURCE_IN_USE", "This resource is referenced by another record.");
  }
  if (typeof error === "object" && error && "type" in error && error.type === "entity.too.large") {
    return new ApiError(413, "PAYLOAD_TOO_LARGE", "The request body exceeds the configured size limit.");
  }
  return new ApiError(500, "INTERNAL_ERROR", "An unexpected server error occurred.");
};

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new ApiError(404, "ROUTE_NOT_FOUND", `No API route exists for ${req.method} ${req.path}.`));
};

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const apiError = mapError(error);
  if (apiError.statusCode >= 500) {
    logger.error("request.failed", error, { requestId: req.requestId, method: req.method, path: req.path });
  }

  res.status(apiError.statusCode).json({
    error: {
      code: apiError.code,
      message: apiError.message,
      ...(apiError.fieldErrors ? { fieldErrors: apiError.fieldErrors } : {}),
      requestId: req.requestId,
    },
  });
};
