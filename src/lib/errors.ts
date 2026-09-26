/**
 * Structured error hierarchy.
 *
 * Every error carries a stable `code`, an HTTP status for API responses, and a
 * `retryable` flag the job system uses to decide whether a retry can help.
 */
export interface AppErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
  retryable?: boolean;
  statusCode?: number;
}

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = options.statusCode ?? 500;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION_ERROR", message, { statusCode: 400, details });
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super("NOT_FOUND", id ? `${resource} ${id} was not found` : `${resource} was not found`, {
      statusCode: 404,
    });
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "Authentication required") {
    super("UNAUTHENTICATED", message, { statusCode: 401 });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have access to this resource") {
    super("FORBIDDEN", message, { statusCode: 403 });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("CONFLICT", message, { statusCode: 409, details });
  }
}

/** A required API key / OAuth credential has not been configured. Never retryable. */
export class MissingCredentialError extends AppError {
  readonly credential: string;
  constructor(credential: string) {
    super(
      "MISSING_CREDENTIAL",
      `Missing credential: set the ${credential} environment variable to enable this integration.`,
      { statusCode: 503, details: { credential } },
    );
    this.credential = credential;
  }
}

export class ExternalServiceError extends AppError {
  readonly provider: string;
  readonly httpStatus?: number;
  constructor(
    provider: string,
    message: string,
    options: AppErrorOptions & { httpStatus?: number } = {},
  ) {
    super("EXTERNAL_SERVICE_ERROR", `${provider}: ${message}`, {
      ...options,
      statusCode: options.statusCode ?? 502,
      details: { ...options.details, provider, httpStatus: options.httpStatus },
    });
    this.provider = provider;
    this.httpStatus = options.httpStatus;
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterMs?: number;
  constructor(provider: string, retryAfterMs?: number) {
    super("RATE_LIMITED", `${provider}: rate limit exceeded`, {
      statusCode: 429,
      retryable: true,
      details: { provider, retryAfterMs },
    });
    this.retryAfterMs = retryAfterMs;
  }
}

export class TimeoutError extends AppError {
  constructor(operation: string, timeoutMs: number) {
    super("TIMEOUT", `${operation} timed out after ${timeoutMs}ms`, {
      statusCode: 504,
      retryable: true,
      details: { operation, timeoutMs },
    });
  }
}

/** Generated content failed the English-only requirement. */
export class LanguageValidationError extends AppError {
  constructor(field: string, reasons: string[], retryable = true) {
    super("NON_ENGLISH_CONTENT", `${field} is not English: ${reasons.join("; ")}`, {
      statusCode: 422,
      retryable,
      details: { field, reasons },
    });
  }
}

export class ContentPolicyError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("CONTENT_POLICY", message, { statusCode: 422, details });
  }
}

export class QualityCheckError extends AppError {
  constructor(message: string, details?: Record<string, unknown>, retryable = false) {
    super("QUALITY_CHECK_FAILED", message, { statusCode: 422, details, retryable });
  }
}

export class LimitExceededError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("LIMIT_EXCEEDED", message, { statusCode: 429, details });
  }
}

export class CancelledError extends AppError {
  constructor(message = "Operation was cancelled") {
    super("CANCELLED", message, { statusCode: 409 });
  }
}

export class MediaProcessingError extends AppError {
  constructor(message: string, details?: Record<string, unknown>, retryable = true) {
    super("MEDIA_PROCESSING_ERROR", message, { statusCode: 500, details, retryable });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Whether a retry of the failed operation might succeed. Unknown errors are retryable. */
export function isRetryable(error: unknown): boolean {
  if (isAppError(error)) return error.retryable;
  return true;
}
