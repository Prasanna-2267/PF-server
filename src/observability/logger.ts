import { getConfig } from "../config/env.js";

type LogLevel = "debug" | "info" | "warn" | "error";
type LogFields = Record<string, unknown>;

const levelWeights: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const normalizeError = (error: unknown): LogFields => {
  if (!(error instanceof Error)) return { errorType: typeof error };
  const fields: LogFields = { errorName: error.name, errorMessage: error.message };
  if (getConfig().environment !== "production" && error.stack) fields.stack = error.stack;
  return fields;
};

const write = (level: LogLevel, message: string, fields: LogFields = {}): void => {
  if (levelWeights[level] < levelWeights[getConfig().logLevel]) return;
  const record = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...fields });
  if (level === "error") console.error(record);
  else if (level === "warn") console.warn(record);
  else console.log(record);
};

export const logger = {
  debug: (message: string, fields?: LogFields) => write("debug", message, fields),
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, error?: unknown, fields: LogFields = {}) =>
    write("error", message, { ...fields, ...normalizeError(error) }),
};
