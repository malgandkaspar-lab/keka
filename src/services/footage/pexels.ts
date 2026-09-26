import { z } from "zod";
import { stableHash } from "@/lib/crypto";
import { ExternalServiceError } from "@/lib/errors";
import { request, requestJson } from "@/lib/http";
import { getCached, setCached } from "@/services/cache/api-cache";
import type { FootageCandidate, FootageSearchOptions, VideoProvider } from "./types";

/**
 * PexelsProvider - licensed stock video and photos from https://www.pexels.com.
 *
 * API: https://api.pexels.com (videos/search, v1/search) with the `Authorization` header.
 * Configuration: PEXELS_API_KEY.
 * License: Pexels License (free to use, attribution appreciated) - recorded per asset.
 * Caching: search responses are cached for 7 days to respect the API rate limit.
 */
const PROVIDER = "pexels";
const LICENSE = "Pexels License";
const LICENSE_URL = "https://www.pexels.com/license/";
const CACHE_TTL_SEC = 7 * 24 * 3600;

const videoSearchSchema = z.object({
  videos: z.array(
    z.object({
      id: z.number(),
      width: z.number(),
      height: z.number(),
      url: z.string(),
      image: z.string().optional().nullable(),
      duration: z.number(),
      user: z.object({ name: z.string(), url: z.string().optional().nullable() }),
      video_files: z.array(
        z.object({
          link: z.string(),
          width: z.number().nullable(),
          height: z.number().nullable(),
          fps: z.number().optional().nullable(),
          quality: z.string().optional().nullable(),
          file_type: z.string().optional().nullable(),
        }),
      ),
    }),
  ),
});

const photoSearchSchema = z.object({
  photos: z.array(
    z.object({
      id: z.number(),
      width: z.number(),
      height: z.number(),
      url: z.string(),
      photographer: z.string(),
      photographer_url: z.string().optional().nullable(),
      src: z.object({ original: z.string(), large2x: z.string().optional(), portrait: z.string().optional() }),
    }),
  ),
});

export class PexelsProvider implements VideoProvider {
  readonly name = PROVIDER;

  constructor(private readonly apiKey: string) {}

  private async get<T>(url: string, signal?: AbortSignal): Promise<T> {
    return requestJson<T>(url, {
      provider: PROVIDER,
      headers: { authorization: this.apiKey },
      timeoutMs: 20_000,
      retries: 3,
      signal,
    });
  }

  async searchVideos(query: string, options: FootageSearchOptions = {}): Promise<FootageCandidate[]> {
    const params = new URLSearchParams({
      query,
      per_page: String(options.perPage ?? 15),
      page: String(options.page ?? 1),
      size: "medium",
    });
    if (options.orientation) params.set("orientation", options.orientation);
    const cacheKey = `pexels:videos:${stableHash(params.toString())}`;
    let raw = await getCached<unknown>(cacheKey);
    if (!raw) {
      raw = await this.get<unknown>(`https://api.pexels.com/videos/search?${params}`, options.signal);
      await setCached(cacheKey, "footage", raw, CACHE_TTL_SEC);
    }
    const parsed = videoSearchSchema.safeParse(raw);
    if (!parsed.success) throw new ExternalServiceError(PROVIDER, "unexpected video search response shape");
    return parsed.data.videos.map((video, rank) => ({
      provider: PROVIDER,
      kind: "video" as const,
      id: String(video.id),
      pageUrl: video.url,
      width: video.width,
      height: video.height,
      durationSec: video.duration,
      author: video.user.name,
      authorUrl: video.user.url ?? undefined,
      license: LICENSE,
      licenseUrl: LICENSE_URL,
      previewImage: video.image ?? undefined,
      files: video.video_files
        .filter((f) => f.width && f.height && (f.file_type ?? "video/mp4") === "video/mp4")
        .map((f) => ({ url: f.link, width: f.width!, height: f.height!, fps: f.fps ?? undefined, quality: f.quality ?? undefined })),
      query,
      rank,
    }));
  }

  async searchImages(query: string, options: FootageSearchOptions = {}): Promise<FootageCandidate[]> {
    const params = new URLSearchParams({ query, per_page: String(options.perPage ?? 15), page: String(options.page ?? 1) });
    if (options.orientation) params.set("orientation", options.orientation);
    const cacheKey = `pexels:photos:${stableHash(params.toString())}`;
    let raw = await getCached<unknown>(cacheKey);
    if (!raw) {
      raw = await this.get<unknown>(`https://api.pexels.com/v1/search?${params}`, options.signal);
      await setCached(cacheKey, "footage", raw, CACHE_TTL_SEC);
    }
    const parsed = photoSearchSchema.safeParse(raw);
    if (!parsed.success) throw new ExternalServiceError(PROVIDER, "unexpected photo search response shape");
    return parsed.data.photos.map((photo, rank) => ({
      provider: PROVIDER,
      kind: "image" as const,
      id: `photo-${photo.id}`,
      pageUrl: photo.url,
      width: photo.width,
      height: photo.height,
      durationSec: 0,
      author: photo.photographer,
      authorUrl: photo.photographer_url ?? undefined,
      license: LICENSE,
      licenseUrl: LICENSE_URL,
      previewImage: photo.src.portrait ?? photo.src.large2x,
      files: [{ url: photo.src.large2x ?? photo.src.original, width: photo.width, height: photo.height }],
      query,
      rank,
    }));
  }

  async download(url: string, signal?: AbortSignal): Promise<Buffer> {
    const host = new URL(url).hostname;
    if (!/(^|\.)(pexels\.com|vimeo\.com|vimeocdn\.com)$/.test(host)) throw new ExternalServiceError(PROVIDER, `refusing to download from ${host}`);
    const res = await request(url, { provider: PROVIDER, timeoutMs: 180_000, retries: 3, signal });
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 10_000) throw new ExternalServiceError(PROVIDER, "downloaded media is too small", { retryable: true });
    return buffer;
  }
}
