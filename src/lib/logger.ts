import pino, { type Logger } from "pino";

/**
 * Structured application logger (JSON to stdout).
 *
 * Secrets are redacted by key name wherever they appear in log context.
 * Pipeline events that must be visible in the UI are additionally persisted
 * via `services/logging/system-log.ts`.
 */
const REDACT_PATHS = [
  "apiKey",
  "*.apiKey",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "headers['xi-api-key']",
  "password",
  "*.password",
  "token",
  "*.token",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "secret",
  "*.secret",
];

let root: Logger | undefined;

export function getLogger(): Logger {
  if (!root) {
    root = pino({
      level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      base: { service: process.env.SERVICE_NAME ?? "shorts-factory" },
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
  return root;
}

export function createLogger(bindings: Record<string, unknown>): Logger {
  return getLogger().child(bindings);
}
