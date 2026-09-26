import { db } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import { getQueue } from "@/queues";
import { logEvent } from "@/services/logging/system-log";
import { enqueueStep, startOrResume } from "./orchestrator";
import { PROCESSING_STATUSES, STEP_DEFINITIONS } from "./steps";

/**
 * Crash recovery.
 *
 * BullMQ already re-queues jobs whose worker died mid-run (stalled job detection).
 * This reconciler additionally repairs state the queue cannot know about:
 *  - GenerationJobs marked QUEUED/RUNNING whose BullMQ job no longer exists
 *    (e.g. Redis was flushed or ran without persistence) are re-enqueued;
 *  - videos in a processing state with no active job are resumed from the first
 *    incomplete step (completed steps are never repeated).
 */
const log = createLogger({ module: "recovery" });

export async function reconcilePipeline(): Promise<{ requeued: number; resumed: number }> {
  let requeued = 0;
  let resumed = 0;
  const activeJobs = await db.generationJob.findMany({ where: { status: { in: ["QUEUED", "RUNNING"] } } });
  for (const job of activeJobs) {
    const queue = getQueue(STEP_DEFINITIONS[job.step].queue);
    const queueJob = await queue.getJob(job.queueJobId ?? job.id);
    const state = queueJob ? await queueJob.getState() : "missing";
    if (state === "missing" || state === "unknown" || state === "completed" || state === "failed") {
      const video = await db.video.findUnique({ where: { id: job.videoId } });
      await db.generationJob.update({ where: { id: job.id }, data: { status: "FAILED", error: `recovered: queue job ${state}`, finishedAt: new Date() } });
      if (video && !video.cancelRequested && video.status !== "CANCELLED" && video.status !== "FAILED") {
        await enqueueStep(job.videoId, job.step);
        await logEvent({ level: "WARN", userId: video.userId, videoId: video.id, step: job.step, message: `Recovered interrupted step (${state}); re-queued` });
        requeued++;
      }
    }
  }

  const stuck = await db.video.findMany({ where: { status: { in: PROCESSING_STATUSES }, cancelRequested: false } });
  for (const video of stuck) {
    const active = await db.generationJob.count({ where: { videoId: video.id, status: { in: ["QUEUED", "RUNNING"] } } });
    if (active > 0) continue;
    if (video.status === "UPLOADING") continue; // uploads are only retried explicitly or by their own job
    await startOrResume(video.id);
    await logEvent({ level: "WARN", userId: video.userId, videoId: video.id, message: "Resumed generation after restart" });
    resumed++;
  }
  if (requeued || resumed) log.warn({ requeued, resumed }, "pipeline reconciled");
  return { requeued, resumed };
}
