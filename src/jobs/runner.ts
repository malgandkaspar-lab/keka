import { UnrecoverableError, type Job } from "bullmq";
import type { PipelineStep, Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { CancelledError, errorMessage, isRetryable, TimeoutError } from "@/lib/errors";
import type { StepJobData } from "@/queues";
import { logEvent } from "@/services/logging/system-log";
import { advance, reroute } from "@/services/pipeline/orchestrator";
import { STEP_DEFINITIONS } from "@/services/pipeline/steps";
import { STEP_HANDLERS } from "./registry";
import type { StepContext, StepHandler } from "./types";

/**
 * Generic pipeline step processor used by every BullMQ worker.
 *
 * Responsibilities: idempotency (a COMPLETED/CANCELLED job is never re-run), timeout and
 * cancellation (AbortSignal), structured logs for every transition, progress reporting,
 * cost accounting, retry classification (non-retryable errors stop BullMQ retries) and
 * advancing the pipeline to the next step after success.
 */
const CANCEL_POLL_MS = 3000;

export interface ProcessOptions {
  handlers?: Partial<Record<PipelineStep, StepHandler>>;
}

export async function processStepJob(job: Job<StepJobData>, options: ProcessOptions = {}): Promise<Record<string, unknown>> {
  const { videoId, generationJobId } = job.data;
  const step = job.data.step as PipelineStep;
  const def = STEP_DEFINITIONS[step];
  const handler = options.handlers?.[step] ?? STEP_HANDLERS[step];
  const attempt = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts ?? def.attempts;

  const generationJob = await db.generationJob.findUnique({ where: { id: generationJobId } });
  if (!generationJob) return { skipped: "generation job no longer exists" };
  if (generationJob.status === "COMPLETED" || generationJob.status === "CANCELLED" || generationJob.status === "SUPERSEDED") {
    return { skipped: `already ${generationJob.status.toLowerCase()}` };
  }
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) return { skipped: "video deleted" };
  if (video.cancelRequested || video.status === "CANCELLED") {
    await db.generationJob.update({ where: { id: generationJobId }, data: { status: "CANCELLED", finishedAt: new Date() } });
    return { skipped: "cancelled" };
  }

  const startedAt = new Date();
  await db.$transaction([
    db.generationJob.update({
      where: { id: generationJobId },
      data: { status: "RUNNING", attempts: attempt, startedAt, error: null, progress: 0 },
    }),
    db.video.update({ where: { id: videoId }, data: { status: def.status } }),
  ]);
  await logEvent({
    userId: video.userId,
    videoId,
    jobId: generationJobId,
    step,
    message: attempt > 1 ? `${def.label} (attempt ${attempt}/${maxAttempts})` : def.label,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new TimeoutError(def.jobName, def.timeoutMs)), def.timeoutMs);
  const cancelPoll = setInterval(() => {
    void db.video
      .findUnique({ where: { id: videoId }, select: { cancelRequested: true } })
      .then((v) => {
        if (v?.cancelRequested) controller.abort(new CancelledError());
      })
      .catch(() => undefined);
  }, CANCEL_POLL_MS);

  const ctx: StepContext = {
    videoId,
    userId: video.userId,
    jobId: generationJobId,
    step,
    attempt,
    signal: controller.signal,
    progress: async (percent, note) => {
      const value = Math.max(0, Math.min(100, Math.round(percent)));
      await job.updateProgress({ percent: value, note }).catch(() => undefined);
      await db.generationJob.update({ where: { id: generationJobId }, data: { progress: value } }).catch(() => undefined);
    },
    log: (message, opts = {}) =>
      logEvent({ userId: video.userId, videoId, jobId: generationJobId, step, message, level: opts.level, provider: opts.provider, context: opts.context }),
  };

  try {
    const result = await Promise.race([
      handler(ctx),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? new CancelledError()), { once: true });
      }),
    ]);
    const durationMs = Date.now() - startedAt.getTime();
    const costUsd = result.costUsd ?? 0;
    await db.$transaction([
      db.generationJob.update({
        where: { id: generationJobId },
        data: {
          status: "COMPLETED",
          progress: 100,
          finishedAt: new Date(),
          durationMs,
          costUsd,
          provider: result.provider ?? null,
          output: (result.output ?? {}) as Prisma.InputJsonValue,
        },
      }),
      db.video.update({ where: { id: videoId }, data: { costEstimateUsd: { increment: costUsd } } }),
    ]);
    await logEvent({
      userId: video.userId,
      videoId,
      jobId: generationJobId,
      step,
      provider: result.provider,
      durationMs,
      message: result.message ?? def.doneMessage,
      context: { costUsd: Number(costUsd.toFixed(4)) },
    });
    if (result.reroute) await reroute(videoId, result.reroute.step, result.reroute.reason);
    else await advance(videoId, step);
    return result.output ?? {};
  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    const cancelled = error instanceof CancelledError || (await isCancelled(videoId));
    if (cancelled) {
      await db.generationJob.update({ where: { id: generationJobId }, data: { status: "CANCELLED", finishedAt: new Date(), durationMs } });
      await logEvent({ level: "WARN", userId: video.userId, videoId, jobId: generationJobId, step, message: `${def.jobName} cancelled` });
      throw new UnrecoverableError("cancelled");
    }
    const message = errorMessage(error);
    const willRetry = isRetryable(error) && attempt < maxAttempts;
    await db.generationJob.update({
      where: { id: generationJobId },
      data: { status: willRetry ? "QUEUED" : "FAILED", error: message.slice(0, 4000), durationMs, finishedAt: willRetry ? null : new Date() },
    });
    await logEvent({
      level: willRetry ? "WARN" : "ERROR",
      userId: video.userId,
      videoId,
      jobId: generationJobId,
      step,
      durationMs,
      error: message,
      message: willRetry ? `${def.jobName} failed (attempt ${attempt}/${maxAttempts}), retrying: ${message}` : `${def.jobName} failed: ${message}`,
    });
    if (!willRetry) {
      await db.video.update({ where: { id: videoId }, data: { status: "FAILED", failedStep: step, error: message.slice(0, 4000) } });
      throw new UnrecoverableError(message);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    clearInterval(cancelPoll);
  }
}

async function isCancelled(videoId: string): Promise<boolean> {
  const video = await db.video.findUnique({ where: { id: videoId }, select: { cancelRequested: true } });
  return Boolean(video?.cancelRequested);
}
