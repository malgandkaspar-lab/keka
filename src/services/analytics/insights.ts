import { db } from "@/lib/db";

/**
 * Performance learning: aggregates analytics snapshots into per-dimension insights
 * (category, hook style, duration bucket, template, publish hour) and turns them into
 * soft guidance for future generation. Never used to deceive or manipulate: it only
 * biases topic/hook/format choices toward what viewers genuinely watched.
 */
export interface InsightRow {
  dimension: string;
  value: string;
  sampleSize: number;
  avgViews: number;
  avgViewPct: number | null;
  avgLikes: number | null;
  score: number;
}

const MIN_SAMPLE = 3;

export function durationBucket(seconds: number | null | undefined): string {
  if (!seconds) return "unknown";
  if (seconds <= 20) return "<=20s";
  if (seconds <= 35) return "21-35s";
  if (seconds <= 50) return "36-50s";
  return ">50s";
}

export async function computeInsights(userId: string): Promise<InsightRow[]> {
  const videos = await db.video.findMany({
    where: { userId, youtubeVideoId: { not: null } },
    include: {
      analytics: { orderBy: { capturedAt: "desc" }, take: 1 },
      template: { select: { key: true } },
      script: { include: { currentVersion: { select: { hookStyle: true } } } },
    },
  });
  const groups = new Map<string, { dimension: string; value: string; views: number[]; pct: number[]; likes: number[] }>();
  const add = (dimension: string, value: string | null | undefined, snapshot: { views: number | null; averageViewPercentage: number | null; likes: number | null }) => {
    if (!value) return;
    const key = `${dimension}:${value}`;
    const group = groups.get(key) ?? { dimension, value, views: [], pct: [], likes: [] };
    if (snapshot.views != null) group.views.push(snapshot.views);
    if (snapshot.averageViewPercentage != null) group.pct.push(snapshot.averageViewPercentage);
    if (snapshot.likes != null) group.likes.push(snapshot.likes);
    groups.set(key, group);
  };
  for (const video of videos) {
    const snapshot = video.analytics[0];
    if (!snapshot) continue;
    add("category", video.category, snapshot);
    add("hookStyle", video.script?.currentVersion?.hookStyle, snapshot);
    add("duration", durationBucket(video.actualDurationSec ?? video.targetDurationSec), snapshot);
    add("template", video.template?.key, snapshot);
    if (video.publishedAt) add("publishHourUtc", String(video.publishedAt.getUTCHours()), snapshot);
  }
  const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
  const rows: InsightRow[] = [];
  for (const group of groups.values()) {
    if (group.views.length < MIN_SAMPLE) continue;
    const avgViews = mean(group.views) ?? 0;
    const avgViewPct = mean(group.pct);
    const avgLikes = mean(group.likes);
    // Retention matters more than raw views for Shorts; combine both on a log scale.
    const score = Math.log10(1 + avgViews) * 10 + (avgViewPct ?? 0) * 0.5;
    rows.push({ dimension: group.dimension, value: group.value, sampleSize: group.views.length, avgViews, avgViewPct, avgLikes, score: Number(score.toFixed(2)) });
  }
  return rows.sort((a, b) => b.score - a.score);
}

export async function refreshInsights(userId: string): Promise<InsightRow[]> {
  const rows = await computeInsights(userId);
  await db.$transaction([
    db.performanceInsight.deleteMany({ where: { userId } }),
    db.performanceInsight.createMany({ data: rows.map((r) => ({ ...r, userId })) }),
  ]);
  return rows;
}

export async function topInsights(userId: string, dimension: string, limit = 3) {
  return db.performanceInsight.findMany({ where: { userId, dimension }, orderBy: { score: "desc" }, take: limit });
}

/** Soft hints for topic generation. Empty until enough analytics exist. */
export async function performanceHints(userId: string): Promise<string[]> {
  const [categories, hooks, durations] = await Promise.all([
    topInsights(userId, "category"),
    topInsights(userId, "hookStyle"),
    topInsights(userId, "duration"),
  ]);
  const hints: string[] = [];
  if (categories.length) hints.push(`Best performing categories: ${categories.map((c) => c.value).join(", ")}`);
  if (hooks.length) hints.push(`Best performing hook styles: ${hooks.map((h) => h.value).join(", ")}`);
  if (durations.length) hints.push(`Best performing durations: ${durations.map((d) => d.value).join(", ")}`);
  return hints;
}

export async function preferredHookStyles(userId: string): Promise<string[]> {
  return (await topInsights(userId, "hookStyle")).map((h) => h.value);
}
