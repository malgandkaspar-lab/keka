import type { LogLevel, PipelineStep, Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { createLogger } from "@/lib/logger";

/**
 * SystemLog: structured, persisted events shown in the UI (per video and globally).
 * Each entry carries job ID, video ID, user ID, step, provider, duration and error.
 * Secrets must never be passed in `context`.
 */
export interface LogEventInput {
  level?: LogLevel;
  message: string;
  userId?: string | null;
  videoId?: string | null;
  jobId?: string | null;
  step?: PipelineStep | null;
  provider?: string | null;
  durationMs?: number | null;
  error?: string | null;
  context?: Record<string, unknown>;
}

const log = createLogger({ module: "system-log" });
const SECRET_KEY_PATTERN = /(key|token|secret|password|authorization)/i;

function scrub(context: Record<string, unknown> | undefined): Prisma.InputJsonValue {
  if (!context) return {};
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    clean[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : value;
  }
  return JSON.parse(JSON.stringify(clean)) as Prisma.InputJsonValue;
}

export async function logEvent(input: LogEventInput): Promise<void> {
  const level = input.level ?? "INFO";
  const payload = {
    videoId: input.videoId,
    jobId: input.jobId,
    step: input.step,
    provider: input.provider,
    durationMs: input.durationMs,
    userId: input.userId,
  };
  const pinoLevel = level === "ERROR" ? "error" : level === "WARN" ? "warn" : level === "DEBUG" ? "debug" : "info";
  log[pinoLevel]({ ...payload, error: input.error, ...input.context }, input.message);
  try {
    await db.systemLog.create({
      data: {
        level,
        message: input.message.slice(0, 2000),
        userId: input.userId ?? null,
        videoId: input.videoId ?? null,
        jobId: input.jobId ?? null,
        step: input.step ?? null,
        provider: input.provider ?? null,
        durationMs: input.durationMs ?? null,
        error: input.error?.slice(0, 4000) ?? null,
        context: scrub(input.context),
      },
    });
  } catch (error) {
    // Logging must never break the pipeline.
    log.error({ err: error }, "failed to persist system log");
  }
}
