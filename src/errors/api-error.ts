export type FieldErrors = Record<string, string[]>;

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly fieldErrors?: FieldErrors;

  constructor(statusCode: number, code: string, message: string, fieldErrors?: FieldErrors) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export const badRequest = (code: string, message: string, fieldErrors?: FieldErrors) =>
  new ApiError(400, code, message, fieldErrors);
export const unauthorized = (message = "Authentication is required.") =>
  new ApiError(401, "AUTHENTICATION_REQUIRED", message);
export const forbidden = (code = "ACCESS_DENIED", message = "You do not have permission to perform this action.") =>
  new ApiError(403, code, message);
export const notFound = (code: string, message: string) => new ApiError(404, code, message);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
export const serviceUnavailable = (code: string, message: string) => new ApiError(503, code, message);
