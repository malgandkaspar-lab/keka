import { db } from "@/lib/db";
import { PROCESSING_STATUSES } from "@/services/pipeline/steps";
import { usageSummary } from "@/services/cost/limits-service";
import { getUserSettings } from "@/services/settings/settings-service";

/** Aggregates for the dashboard (counts, next scheduled run, recent videos and jobs). */
export async function dashboardData(userId: string) {
  const settings = await getUserSettings(userId);
  const [generated, published, scheduled, failed, processing, ready, nextSchedule, nextScheduledVideo, recentVideos, recentJobs, usage] = await Promise.all([
    db.video.count({ where: { userId, renderAssetId: { not: null } } }),
    db.video.count({ where: { userId, status: "PUBLISHED" } }),
    db.video.count({ where: { userId, status: "SCHEDULED" } }),
    db.video.count({ where: { userId, status: "FAILED" } }),
    db.video.count({ where: { userId, status: { in: PROCESSING_STATUSES } } }),
    db.video.count({ where: { userId, status: "READY" } }),
    db.schedule.findFirst({ where: { userId, enabled: true, nextRunAt: { not: null } }, orderBy: { nextRunAt: "asc" } }),
    db.video.findFirst({ where: { userId, status: "SCHEDULED", scheduledPublishAt: { gt: new Date() } }, orderBy: { scheduledPublishAt: "asc" } }),
    db.video.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { topic: { select: { title: true } }, thumbnailAsset: { select: { storageKey: true } } },
    }),
    db.generationJob.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: 12,
      include: { video: { select: { title: true, requestedTopic: true, topic: { select: { title: true } } } } },
    }),
    usageSummary(userId, settings),
  ]);
  return {
    counts: { generated, published, scheduled, failed, processing, ready },
    nextSchedule,
    nextScheduledVideo,
    recentVideos,
    recentJobs,
    usage,
  };
}
