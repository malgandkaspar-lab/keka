import type { GenerationJob, PipelineStep, Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { getQueue, type StepJobData } from "@/queues";
import { logEvent } from "@/services/logging/system-log";
import {
  ALL_STEPS,
  dependentSteps,
  GENERATION_STEPS,
  nextStepAfter,
  PUBLISH_STEPS,
  STEP_DEFINITIONS,
} from "./steps";

/**
 * Pipeline orchestrator.
 *
 * The source of truth for progress is the GenerationJob table: a step is done when it
 * has a COMPLETED job that has not been SUPERSEDED. That makes the pipeline resumable
 * (a failure at step N never repeats steps 1..N-1), idempotent (re-delivered queue jobs
 * are ignored) and recoverable after crashes (the reconciler re-enqueues from the DB).
 */
const ACTIVE_JOB_STATUSES = ["QUEUED", "RUNNING"] as const;

export async function completedSteps(videoId: string): Promise<Set<PipelineStep>> {
  const jobs = await db.generationJob.findMany({
    where: { videoId, status: "COMPLETED" },
    select: { step: true },
  });
  return new Set(jobs.map((j) => j.step));
}

export async function nextPendingStep(videoId: string, steps: PipelineStep[] = GENERATION_STEPS): Promise<PipelineStep | null> {
  const done = await completedSteps(videoId);
  return steps.find((s) => !done.has(s)) ?? null;
}

export async function activeJob(videoId: string): Promise<GenerationJob | null> {
  return db.generationJob.findFirst({
    where: { videoId, status: { in: [...ACTIVE_JOB_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
}

/** Records a step as completed without running it (e.g. manual topic). */
export async function markStepSkipped(videoId: string, userId: string, step: PipelineStep, reason: string): Promise<void> {
  const def = STEP_DEFINITIONS[step];
  await db.generationJob.create({
    data: {
      videoId,
      userId,
      step,
      status: "COMPLETED",
      queueName: def.queue,
      progress: 100,
      output: { skipped: true, reason },
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 0,
    },
  });
}

/** Enqueues a step (idempotent: returns the existing active job for that step). */
export async function enqueueStep(videoId: string, step: PipelineStep, options: { delayMs?: number } = {}): Promise<GenerationJob> {
  const video = await db.video.findUnique({ where: { id: videoId }, select: { id: true, userId: true, status: true } });
  if (!video) throw new NotFoundError("Video", videoId);

  const existing = await db.generationJob.findFirst({
    where: { videoId, step, status: { in: [...ACTIVE_JOB_STATUSES] } },
  });
  if (existing) return existing;

  const def = STEP_DEFINITIONS[step];
  const job = await db.generationJob.create({
    data: { videoId, userId: video.userId, step, queueName: def.queue, maxAttempts: def.attempts },
  });
  const data: StepJobData = { videoId, generationJobId: job.id, step, userId: video.userId };
  const queueJob = await getQueue(def.queue).add(def.jobName, data, {
    jobId: job.id,
    attempts: def.attempts,
    backoff: { type: "exponential", delay: step === "YOUTUBE_UPLOAD" ? 60_000 : 10_000 },
    delay: options.delayMs,
  });
  return db.generationJob.update({ where: { id: job.id }, data: { queueJobId: queueJob.id ?? job.id } });
}

/** Starts or resumes generation from the first incomplete step. */
export async function startOrResume(videoId: string): Promise<GenerationJob | null> {
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) throw new NotFoundError("Video", videoId);
  const running = await activeJob(videoId);
  if (running) return running;

  const next = await nextPendingStep(videoId);
  if (!next) {
    await db.video.update({ where: { id: videoId }, data: { status: "READY", error: null, failedStep: null } });
    return null;
  }
  await db.video.update({
    where: { id: videoId },
    data: { status: STEP_DEFINITIONS[next].status, error: null, failedStep: null, cancelRequested: false },
  });
  return enqueueStep(videoId, next);
}

/** Called by the worker after a step completes: moves the video to its next state. */
export async function advance(videoId: string, completed: PipelineStep): Promise<void> {
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video || video.cancelRequested || video.status === "CANCELLED") return;

  if (GENERATION_STEPS.includes(completed)) {
    const next = await nextPendingStep(videoId);
    if (next) {
      await db.video.update({ where: { id: videoId }, data: { status: STEP_DEFINITIONS[next].status } });
      await enqueueStep(videoId, next);
      return;
    }
    await db.video.update({ where: { id: videoId }, data: { status: "READY", error: null, failedStep: null } });
    await logEvent({ userId: video.userId, videoId, message: "Video is ready", context: { status: "READY" } });
    if (video.autoPublish) await requestPublish(videoId);
    return;
  }

  const next = nextStepAfter(completed);
  if (next && PUBLISH_STEPS.includes(next)) await enqueueStep(videoId, next);
}

/** Re-routes the pipeline back to an earlier step (e.g. research found the topic unusable). */
export async function reroute(videoId: string, toStep: PipelineStep, reason: string): Promise<void> {
  await supersede(videoId, dependentSteps(toStep));
  const video = await db.video.findUniqueOrThrow({ where: { id: videoId } });
  await logEvent({ level: "WARN", userId: video.userId, videoId, step: toStep, message: `Re-running from "${STEP_DEFINITIONS[toStep].label.replace("...", "")}": ${reason}` });
  await db.video.update({ where: { id: videoId }, data: { status: STEP_DEFINITIONS[toStep].status } });
  await enqueueStep(videoId, toStep);
}

async function supersede(videoId: string, steps: PipelineStep[]): Promise<void> {
  await db.generationJob.updateMany({
    where: { videoId, step: { in: steps }, status: "COMPLETED" },
    data: { status: "SUPERSEDED" },
  });
}

/** Partial regeneration: only the chosen component and what depends on it re-run. */
export async function regenerate(videoId: string, fromStep: PipelineStep): Promise<GenerationJob | null> {
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) throw new NotFoundError("Video", videoId);
  if (await activeJob(videoId)) throw new ConflictError("This video is currently processing. Cancel it or wait for it to finish.");
  if (video.youtubeVideoId) {
    throw new ConflictError("This video has already been uploaded to YouTube. Duplicate it to create a new version.");
  }
  await supersede(videoId, dependentSteps(fromStep));
  if (fromStep === "GENERATE_TOPIC") {
    await db.video.update({ where: { id: videoId }, data: { topicId: video.autoTopic ? null : video.topicId } });
    if (!video.autoTopic && video.topicId) {
      // Manual topics are kept; mark the topic step as satisfied again.
      await markStepSkipped(videoId, video.userId, "GENERATE_TOPIC", "manual topic");
    }
  }
  await db.video.update({ where: { id: videoId }, data: { cancelRequested: false, error: null, failedStep: null } });
  return startOrResume(videoId);
}

/** Cancels processing: waiting queue jobs are removed and running handlers abort. */
export async function cancel(videoId: string): Promise<void> {
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) throw new NotFoundError("Video", videoId);
  await db.video.update({ where: { id: videoId }, data: { cancelRequested: true, status: "CANCELLED" } });
  const active = await db.generationJob.findMany({ where: { videoId, status: { in: [...ACTIVE_JOB_STATUSES] } } });
  for (const job of active) {
    const queueJob = await getQueue(STEP_DEFINITIONS[job.step].queue).getJob(job.queueJobId ?? job.id);
    const state = queueJob ? await queueJob.getState() : "unknown";
    if (queueJob && (state === "waiting" || state === "delayed" || state === "prioritized")) await queueJob.remove();
    if (state !== "active") {
      await db.generationJob.update({ where: { id: job.id }, data: { status: "CANCELLED", finishedAt: new Date() } });
    }
  }
  await logEvent({ level: "WARN", userId: video.userId, videoId, message: "Generation cancelled by user" });
}

/** Queues a YouTube upload (respecting duplicate protection). */
export async function requestPublish(videoId: string): Promise<GenerationJob | null> {
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) throw new NotFoundError("Video", videoId);
  if (video.status !== "READY" && video.status !== "FAILED" && video.status !== "UPLOADING") {
    throw new ConflictError(`Video must be READY to publish (current status: ${video.status})`);
  }
  const pending = await nextPendingStep(videoId, GENERATION_STEPS);
  if (pending) throw new ConflictError(`Video generation is not complete (next step: ${pending})`);
  const publishStep = video.youtubeVideoId ? "YOUTUBE_PUBLISH" : "YOUTUBE_UPLOAD";
  await supersede(videoId, publishStep === "YOUTUBE_UPLOAD" ? PUBLISH_STEPS : ["YOUTUBE_PUBLISH"]);
  await db.video.update({ where: { id: videoId }, data: { status: "UPLOADING", error: null, failedStep: null } });
  return enqueueStep(videoId, publishStep);
}

export async function recordStepOutput(jobId: string, data: Prisma.GenerationJobUpdateInput): Promise<void> {
  await db.generationJob.update({ where: { id: jobId }, data });
}

export { ALL_STEPS };
