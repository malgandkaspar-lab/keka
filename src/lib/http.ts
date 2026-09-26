import { CancelledError, ExternalServiceError, RateLimitError, TimeoutError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

/**
 * Resilient HTTP client used by every external integration (ElevenLabs, Pexels, ...).
 *
 * - per-attempt timeout (AbortController)
 * - retries with exponential backoff + jitter on network errors, 408/425/429/5xx
 * - honours Retry-After on 429 responses
 * - converts failures into structured AppErrors that name the provider
 */
export interface RequestOptions extends Omit<RequestInit, "signal"> {
  provider: string;
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const log = createLogger({ module: "http" });

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * baseDelayMs;
  return Math.min(maxDelayMs, exponential + jitter);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return "";
  }
}

/** Performs a request and returns the successful Response (status 2xx). */
export async function request(url: string, options: RequestOptions): Promise<Response> {
  const {
    provider,
    timeoutMs = 30_000,
    retries = 3,
    baseDelayMs = 500,
    maxDelayMs = 15_000,
    signal,
    ...init
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new CancelledError();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new TimeoutError(`${provider} request`, timeoutMs)), timeoutMs);

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (res.ok) return res;

      const body = await readErrorBody(res);
      if (res.status === 429) {
        const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
        lastError = new RateLimitError(provider, retryAfterMs);
        if (attempt < retries) {
          await sleep(retryAfterMs ?? backoffDelay(attempt, baseDelayMs, maxDelayMs), signal);
          continue;
        }
        throw lastError;
      }
      const retryable = RETRYABLE_STATUS.has(res.status);
      lastError = new ExternalServiceError(provider, `HTTP ${res.status}: ${body || res.statusText}`, {
        httpStatus: res.status,
        retryable,
      });
      if (retryable && attempt < retries) {
        await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs), signal);
        continue;
      }
      throw lastError;
    } catch (error) {
      if (error instanceof ExternalServiceError || error instanceof RateLimitError) throw error;
      if (signal?.aborted) throw new CancelledError();
      const timedOut = controller.signal.aborted;
      lastError = timedOut
        ? new TimeoutError(`${provider} request`, timeoutMs)
        : new ExternalServiceError(provider, `network error: ${(error as Error).message}`, {
            retryable: true,
            cause: error,
          });
      if (attempt < retries) {
        log.warn({ provider, attempt, err: (error as Error).message }, "request failed, retrying");
        await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs), signal);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastError;
}

export async function requestJson<T>(url: string, options: RequestOptions): Promise<T> {
  const res = await request(url, {
    ...options,
    headers: { accept: "application/json", ...(options.headers ?? {}) },
  });
  try {
    return (await res.json()) as T;
  } catch (error) {
    throw new ExternalServiceError(options.provider, "response was not valid JSON", { cause: error });
  }
}

/** Generic retry helper for non-HTTP operations (SDK calls, ffmpeg). */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    retries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const { retries = 3, baseDelayMs = 500, maxDelayMs = 15_000, shouldRetry = () => true, signal } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !shouldRetry(error) || signal?.aborted) throw error;
      const retryAfter = error instanceof RateLimitError ? error.retryAfterMs : undefined;
      await sleep(retryAfter ?? backoffDelay(attempt, baseDelayMs, maxDelayMs), signal);
    }
  }
  throw lastError;
}
