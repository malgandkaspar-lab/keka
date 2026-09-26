import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { Prisma, VideoScene } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import { withWorkDir } from "@/lib/workdir";
import { storeAsset } from "@/services/media/media-service";
import type { FootageCandidate, FootageFile, VideoProvider } from "./types";

/**
 * FootageService - search, rank, select and download stock footage per scene.
 *
 * Search strategy (never leaves a scene blank):
 *   1. scene keywords (portrait orientation)
 *   2. scene keywords (any orientation, cropped to 9:16 at render time)
 *   3. broader fallback keywords
 *   4. video-level fallback (topic / category keywords)
 *   5. still images (animated with Ken Burns motion at render), if enabled
 *   6. reuse of a clip already selected for another scene of this video
 *
 * Ranking: relevance (provider rank), vertical orientation, resolution, sufficient
 * duration, and uniqueness (not used elsewhere in this video or recent videos).
 */
const log = createLogger({ module: "footage" });

export interface SearchLogEntry {
  query: string;
  orientation: string;
  kind: "video" | "image";
  results: number;
}

export interface SceneSearchResult {
  candidates: FootageCandidate[];
  searchLog: SearchLogEntry[];
}

const MIN_CANDIDATES = 3;

export async function searchSceneFootage(opts: {
  provider: VideoProvider;
  keywords: string[];
  fallbackKeywords: string[];
  videoFallbackKeywords: string[];
  allowImages: boolean;
  signal?: AbortSignal;
}): Promise<SceneSearchResult> {
  const searchLog: SearchLogEntry[] = [];
  const seen = new Set<string>();
  const candidates: FootageCandidate[] = [];

  const run = async (query: string, orientation: "portrait" | "landscape" | undefined, kind: "video" | "image") => {
    const results =
      kind === "video"
        ? await opts.provider.searchVideos(query, { orientation, perPage: 15, signal: opts.signal })
        : await opts.provider.searchImages(query, { orientation, perPage: 10, signal: opts.signal });
    searchLog.push({ query, orientation: orientation ?? "any", kind, results: results.length });
    for (const candidate of results) {
      if (seen.has(candidate.id) || candidate.files.length === 0) continue;
      seen.add(candidate.id);
      candidates.push(candidate);
    }
  };

  const stages: [string[], "portrait" | "landscape" | undefined, "video" | "image"][] = [
    [opts.keywords.slice(0, 2), "portrait", "video"],
    [opts.keywords.slice(0, 2), undefined, "video"],
    [opts.fallbackKeywords, "portrait", "video"],
    [opts.fallbackKeywords, undefined, "video"],
    [opts.videoFallbackKeywords, undefined, "video"],
  ];
  if (opts.allowImages) stages.push([[...opts.keywords.slice(0, 1), ...opts.fallbackKeywords.slice(0, 1)], "portrait", "image"]);

  for (const [queries, orientation, kind] of stages) {
    for (const query of queries) {
      if (candidates.filter((c) => c.kind === "video").length >= MIN_CANDIDATES * 2) break;
      try {
        await run(query, orientation, kind);
      } catch (error) {
        log.warn({ query, err: (error as Error).message }, "footage search failed for query");
        searchLog.push({ query, orientation: orientation ?? "any", kind, results: -1 });
        if (searchLog.every((e) => e.results === -1) && searchLog.length >= 3) throw error;
      }
    }
    if (candidates.length >= MIN_CANDIDATES) break;
  }
  return { candidates, searchLog };
}

export interface RankingContext {
  sceneDurationSec: number;
  usedInVideo: Set<string>;
  usedRecently: Set<string>;
}

export function scoreCandidate(candidate: FootageCandidate, ctx: RankingContext): number {
  let score = 100 - candidate.rank * 3;
  const portrait = candidate.height > candidate.width;
  score += portrait ? 25 : candidate.width / candidate.height > 1.7 ? -5 : 5;
  const best = pickBestFile(candidate.files, portrait);
  const shortSide = best ? Math.min(best.width, best.height) : 0;
  score += shortSide >= 1080 ? 20 : shortSide >= 720 ? 5 : -30;
  if (candidate.kind === "video") {
    score += candidate.durationSec >= ctx.sceneDurationSec ? 15 : candidate.durationSec >= ctx.sceneDurationSec * 0.6 ? 0 : -25;
  } else {
    score -= 35; // Prefer real footage over stills.
  }
  if (ctx.usedInVideo.has(candidate.id)) score -= 200;
  if (ctx.usedRecently.has(candidate.id)) score -= 40;
  return score;
}

/** Picks the smallest file that still covers 1080x1920 after cropping, else the largest. */
export function pickBestFile(files: FootageFile[], portrait: boolean): FootageFile | undefined {
  const sorted = [...files].sort((a, b) => a.width * a.height - b.width * b.height);
  const sufficient = sorted.find((f) => (portrait ? f.width >= 1080 && f.height >= 1920 : f.height >= 1080));
  const capped = sorted.filter((f) => f.width * f.height <= 3840 * 2160);
  return sufficient ?? capped.at(-1) ?? sorted.at(-1);
}

export function rankCandidates(candidates: FootageCandidate[], ctx: RankingContext) {
  return candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, ctx) }))
    .sort((a, b) => b.score - a.score);
}

export async function recentlyUsedFootageIds(userId: string, excludeVideoId: string, limit = 30): Promise<Set<string>> {
  const scenes = await db.videoScene.findMany({
    where: { video: { userId, id: { not: excludeVideoId } }, mediaAssetId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: limit * 8,
    select: { mediaAsset: { select: { sourceId: true } } },
  });
  return new Set(scenes.map((s) => s.mediaAsset?.sourceId).filter((id): id is string => Boolean(id)));
}

/** Downloads (or reuses) a candidate and stores it as a MediaAsset with full provenance. */
export async function downloadCandidate(opts: {
  provider: VideoProvider;
  candidate: FootageCandidate;
  userId: string;
  signal?: AbortSignal;
}) {
  const { candidate } = opts;
  const existing = await db.mediaAsset.findFirst({
    where: { source: "PEXELS", sourceId: candidate.id },
  });
  if (existing) return existing;

  const portrait = candidate.height > candidate.width;
  const file = pickBestFile(candidate.files, portrait);
  if (!file) throw new Error(`Candidate ${candidate.id} has no downloadable file`);
  const isVideo = candidate.kind === "video";
  const extension = isVideo ? "mp4" : "jpg";
  const buffer = await opts.provider.download(file.url, opts.signal);

  return withWorkDir("footage", async (dir) => {
    const localPath = path.join(/*turbopackIgnore: true*/ dir, `${candidate.id}.${extension}`);
    await writeFile(localPath, buffer);
    return storeAsset({
      userId: opts.userId,
      kind: isVideo ? "VIDEO_CLIP" : "IMAGE",
      key: `footage/${candidate.provider}/${candidate.id}.${extension}`,
      mimeType: isVideo ? "video/mp4" : "image/jpeg",
      source: "PEXELS",
      filePath: localPath,
      probe: true,
      sourceId: candidate.id,
      sourceUrl: candidate.pageUrl,
      author: candidate.author,
      authorUrl: candidate.authorUrl ?? null,
      license: candidate.license,
      licenseUrl: candidate.licenseUrl,
      metadata: { query: candidate.query, fileUrl: file.url, width: file.width, height: file.height } as Prisma.InputJsonValue,
    });
  });
}

/** Selects and downloads footage for every unlocked scene of a video. */
export async function selectFootageForVideo(opts: {
  provider: VideoProvider;
  videoId: string;
  userId: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ selected: number; reused: number }> {
  const scenes = await db.videoScene.findMany({ where: { videoId: opts.videoId }, orderBy: { index: "asc" } });
  const usedRecently = await recentlyUsedFootageIds(opts.userId, opts.videoId);
  const usedInVideo = new Set<string>();
  for (const scene of scenes) {
    if (scene.locked && scene.mediaAssetId) {
      const asset = await db.mediaAsset.findUnique({ where: { id: scene.mediaAssetId } });
      if (asset?.sourceId) usedInVideo.add(asset.sourceId);
    }
  }

  let selected = 0;
  let reused = 0;
  const fallbackAssets: string[] = [];
  for (const [i, scene] of scenes.entries()) {
    if (scene.locked && scene.mediaAssetId) {
      fallbackAssets.push(scene.mediaAssetId);
      opts.onProgress?.(i + 1, scenes.length);
      continue;
    }
    const assetId = await selectForScene(scene, { ...opts, usedInVideo, usedRecently });
    if (assetId) {
      selected++;
      fallbackAssets.push(assetId);
    } else {
      // Last resort: reuse an already selected clip (different segment at render time).
      const reuseId = fallbackAssets[(i - 1 + fallbackAssets.length) % Math.max(1, fallbackAssets.length)];
      if (!reuseId) throw new Error(`No footage could be found for scene ${scene.index + 1}`);
      await db.videoScene.update({ where: { id: scene.id }, data: { mediaAssetId: reuseId } });
      reused++;
    }
    opts.onProgress?.(i + 1, scenes.length);
  }
  return { selected, reused };
}

async function selectForScene(
  scene: VideoScene,
  opts: {
    provider: VideoProvider;
    userId: string;
    usedInVideo: Set<string>;
    usedRecently: Set<string>;
    signal?: AbortSignal;
  },
): Promise<string | null> {
  const candidates = (scene.candidates as unknown as FootageCandidate[]) ?? [];
  const ranked = rankCandidates(candidates, {
    sceneDurationSec: scene.endSec - scene.startSec,
    usedInVideo: opts.usedInVideo,
    usedRecently: opts.usedRecently,
  });
  for (const { candidate } of ranked.slice(0, 4)) {
    if (opts.usedInVideo.has(candidate.id)) continue;
    try {
      const asset = await downloadCandidate({ provider: opts.provider, candidate, userId: opts.userId, signal: opts.signal });
      opts.usedInVideo.add(candidate.id);
      await db.videoScene.update({ where: { id: scene.id }, data: { mediaAssetId: asset.id } });
      return asset.id;
    } catch (error) {
      log.warn({ sceneId: scene.id, candidate: candidate.id, err: (error as Error).message }, "candidate download failed");
    }
  }
  return null;
}
