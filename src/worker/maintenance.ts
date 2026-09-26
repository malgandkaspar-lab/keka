import type { Job } from "bullmq";
import { getQueue } from "@/queues";
import { collectAllAnalytics, collectAnalyticsForUser, promoteScheduledVideos } from "@/services/analytics/analytics-service";
import { purgeExpiredSessions } from "@/services/auth/auth-service";
import { purgeExpiredCache } from "@/services/cache/api-cache";
import { reconcilePipeline } from "@/services/pipeline/recovery";
import { repairScheduleTimes, runDueSchedules } from "@/services/publishing/scheduler-service";

/**
 * Maintenance jobs (repeatable, registered with BullMQ job schedulers so exactly one
 * instance fires per interval even with several workers):
 *  - scheduler-tick (every minute): run due automatic-mode schedules
 *  - collect-analytics (every 6 hours): YouTube statistics/analytics snapshots
 *  - reconcile (every 5 minutes): recover interrupted pipeline state
 *  - cleanup (daily): expired sessions and cache entries
 */
export const MAINTENANCE_JOBS = {
  "scheduler-tick": { every: 60_000 },
  "collect-analytics": { every: 6 * 3600_000 },
  reconcile: { every: 5 * 60_000 },
  cleanup: { every: 24 * 3600_000 },
} as const;

export async function registerMaintenanceSchedules(): Promise<void> {
  const queue = getQueue("maintenance");
  for (const [name, repeat] of Object.entries(MAINTENANCE_JOBS)) {
    await queue.upsertJobScheduler(name, { every: repeat.every }, { name, data: {}, opts: { removeOnComplete: 100, removeOnFail: 500 } });
  }
}

export async function processMaintenanceJob(job: Job): Promise<Record<string, unknown>> {
  switch (job.name) {
    case "scheduler-tick": {
      await repairScheduleTimes();
      const runs = await runDueSchedules();
      const promoted = await promoteScheduledVideos();
      return { runs, promoted };
    }
    case "collect-analytics":
      return { snapshots: await collectAllAnalytics() };
    case "reconcile":
      return { ...(await reconcilePipeline()) };
    case "cleanup":
      return { sessions: await purgeExpiredSessions(), cache: await purgeExpiredCache() };
    case "collect-analytics-user":
      return { snapshots: await collectAnalyticsForUser((job.data as { userId: string }).userId) };
    default:
      return { ignored: job.name };
  }
}
