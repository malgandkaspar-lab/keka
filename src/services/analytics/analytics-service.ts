import { db } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import { logEvent } from "@/services/logging/system-log";
import { clientForAccount, markAccountError } from "@/services/youtube/youtube-service";
import { AuthenticationError } from "@/lib/errors";
import { refreshInsights } from "./insights";

/**
 * AnalyticsService
 *
 * Purpose: collect historical performance snapshots for uploaded videos.
 * Sources: YouTube Data API statistics (views, likes, comments) for every video, plus
 * YouTube Analytics API metrics (watch time, average view duration/percentage,
 * subscriber changes) when the channel granted the analytics scope. Metrics that are
 * unavailable are stored as null - never guessed.
 * Also flips SCHEDULED videos to PUBLISHED once their publish time has passed.
 */
const log = createLogger({ module: "analytics" });

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function collectAnalyticsForUser(userId: string): Promise<number> {
  const accounts = await db.youTubeAccount.findMany({ where: { userId, status: { not: "REVOKED" } } });
  let snapshots = 0;
  for (const account of accounts) {
    const videos = await db.video.findMany({
      where: { userId, youtubeAccountId: account.id, youtubeVideoId: { not: null } },
      select: { id: true, youtubeVideoId: true, uploadedAt: true, status: true, scheduledPublishAt: true },
    });
    if (videos.length === 0) continue;
    try {
      const client = await clientForAccount(account);
      const stats = await client.getStatistics(videos.map((v) => v.youtubeVideoId!));
      const hasAnalyticsScope = account.scopes.some((s) => s.includes("yt-analytics"));
      for (const video of videos) {
        const stat = stats.get(video.youtubeVideoId!);
        let analytics = null;
        if (hasAnalyticsScope) {
          try {
            const start = video.uploadedAt ?? new Date(Date.now() - 28 * 86400_000);
            analytics = await client.getAnalytics(video.youtubeVideoId!, isoDate(start), isoDate(new Date()));
          } catch (error) {
            log.warn({ videoId: video.id, err: (error as Error).message }, "analytics query failed");
          }
        }
        if (!stat && !analytics) continue;
        await db.analyticsSnapshot.create({
          data: {
            videoId: video.id,
            youtubeVideoId: video.youtubeVideoId!,
            views: stat?.views ?? analytics?.views ?? null,
            likes: stat?.likes ?? analytics?.likes ?? null,
            comments: stat?.comments ?? analytics?.comments ?? null,
            watchTimeMinutes: analytics?.estimatedMinutesWatched ?? null,
            averageViewDuration: analytics?.averageViewDuration ?? null,
            averageViewPercentage: analytics?.averageViewPercentage ?? null,
            subscribersGained: analytics?.subscribersGained ?? null,
            subscribersLost: analytics?.subscribersLost ?? null,
            raw: JSON.parse(JSON.stringify({ stat: stat ?? null, analytics })),
          },
        });
        snapshots++;
        if (video.status === "SCHEDULED" && video.scheduledPublishAt && video.scheduledPublishAt.getTime() <= Date.now()) {
          await db.video.update({ where: { id: video.id }, data: { status: "PUBLISHED", publishedAt: video.scheduledPublishAt, youtubeStatus: "public" } });
        }
      }
    } catch (error) {
      if (error instanceof AuthenticationError) await markAccountError(account.id, error);
      await logEvent({ level: "WARN", userId, message: `Analytics collection failed for "${account.channelTitle}": ${(error as Error).message}`, provider: "youtube" });
    }
  }
  if (snapshots > 0) await refreshInsights(userId);
  return snapshots;
}

export async function collectAllAnalytics(): Promise<number> {
  const users = await db.youTubeAccount.findMany({ distinct: ["userId"], select: { userId: true } });
  let total = 0;
  for (const { userId } of users) total += await collectAnalyticsForUser(userId);
  return total;
}

/** Marks scheduled videos as published once their time passes (no API call needed). */
export async function promoteScheduledVideos(now = new Date()): Promise<number> {
  const res = await db.video.updateMany({
    where: { status: "SCHEDULED", scheduledPublishAt: { lte: now } },
    data: { status: "PUBLISHED", youtubeStatus: "public" },
  });
  return res.count;
}

export async function analyticsOverview(userId: string) {
  const videos = await db.video.findMany({
    where: { userId, youtubeVideoId: { not: null } },
    include: { analytics: { orderBy: { capturedAt: "desc" }, take: 1 } },
    orderBy: { uploadedAt: "desc" },
  });
  const latest = videos.map((v) => ({ video: v, snapshot: v.analytics[0] ?? null }));
  const sum = (key: "views" | "likes" | "comments" | "subscribersGained") =>
    latest.reduce((total, { snapshot }) => total + (snapshot?.[key] ?? 0), 0);
  const watchTime = latest.reduce((total, { snapshot }) => total + (snapshot?.watchTimeMinutes ?? 0), 0);
  const pcts = latest.map(({ snapshot }) => snapshot?.averageViewPercentage).filter((p): p is number => p != null);
  return {
    totals: {
      videos: videos.length,
      views: sum("views"),
      likes: sum("likes"),
      comments: sum("comments"),
      subscribersGained: sum("subscribersGained"),
      watchTimeMinutes: Number(watchTime.toFixed(1)),
      averageViewPercentage: pcts.length ? Number((pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(1)) : null,
    },
    videos: latest.map(({ video, snapshot }) => ({
      id: video.id,
      title: video.title,
      youtubeUrl: video.youtubeUrl,
      uploadedAt: video.uploadedAt,
      category: video.category,
      views: snapshot?.views ?? null,
      likes: snapshot?.likes ?? null,
      comments: snapshot?.comments ?? null,
      averageViewPercentage: snapshot?.averageViewPercentage ?? null,
      capturedAt: snapshot?.capturedAt ?? null,
    })),
    insights: await db.performanceInsight.findMany({ where: { userId }, orderBy: [{ dimension: "asc" }, { score: "desc" }] }),
  };
}
