import path from "node:path";
import type { MusicTrack } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import { withWorkDir } from "@/lib/workdir";
import { storeAsset } from "@/services/media/media-service";
import { mediaInfo } from "@/services/video/ffmpeg";
import { generateMusicBed, generateSfx, MOOD_PROFILES, SFX_TYPES, type SfxType } from "./procedural";

/**
 * MusicProvider / MusicService
 *
 * Purpose: choose royalty-free background music that matches the topic's tone.
 * Providers (in order):
 *  1. LocalLibraryMusicProvider - licensed tracks the user uploaded (license recorded).
 *  2. ProceduralMusicProvider - FFmpeg-synthesised mood beds (no third-party rights).
 * Selection avoids repeating the tracks used in the user's most recent videos.
 * Modes: "none" (no music), "auto" (mood from the visual plan), or a mood key.
 */
const log = createLogger({ module: "music" });
const GENERATED_BED_SEC = 190;

export interface MusicProvider {
  readonly name: string;
  findTrack(opts: { userId: string; mood: string; minDurationSec: number; avoidTrackIds: string[] }): Promise<MusicTrack | null>;
}

export class LocalLibraryMusicProvider implements MusicProvider {
  readonly name = "library";
  async findTrack(opts: { userId: string; mood: string; minDurationSec: number; avoidTrackIds: string[] }) {
    const tracks = await db.musicTrack.findMany({
      where: {
        enabled: true,
        source: { not: "GENERATED" },
        OR: [{ userId: opts.userId }, { userId: null }],
        moods: { has: opts.mood },
      },
    });
    const usable = tracks.filter((t) => t.durationSec >= Math.min(opts.minDurationSec, 30));
    const fresh = usable.filter((t) => !opts.avoidTrackIds.includes(t.id));
    const pool = fresh.length ? fresh : usable;
    return pool.length ? pool[Math.floor(Math.random() * pool.length)]! : null;
  }
}

export class ProceduralMusicProvider implements MusicProvider {
  readonly name = "procedural";
  async findTrack(opts: { userId: string; mood: string; minDurationSec: number; avoidTrackIds: string[] }) {
    const mood = MOOD_PROFILES[opts.mood] ? opts.mood : "documentary";
    const existing = await db.musicTrack.findMany({ where: { source: "GENERATED", moods: { has: mood }, enabled: true } });
    const fresh = existing.filter((t) => !opts.avoidTrackIds.includes(t.id));
    if (fresh.length >= 2 || (existing.length >= 3 && fresh.length > 0)) {
      return fresh[Math.floor(Math.random() * fresh.length)]!;
    }
    const variant = existing.length + 1;
    return withWorkDir("music", async (dir) => {
      const outputPath = path.join(dir, `${mood}-${variant}.m4a`);
      await generateMusicBed({ mood, durationSec: GENERATED_BED_SEC, seed: variant * 7919 + mood.length, outputPath });
      const info = await mediaInfo(outputPath);
      const asset = await storeAsset({
        kind: "AUDIO_MUSIC",
        key: `music/generated/${mood}-v${variant}.m4a`,
        mimeType: "audio/mp4",
        source: "GENERATED",
        filePath: outputPath,
        probe: true,
        license: "Royalty-free: synthesised by Shorts Factory",
      });
      return db.musicTrack.create({
        data: {
          title: `Generated ${mood} bed #${variant}`,
          moods: [mood],
          durationSec: info.durationSec,
          assetId: asset.id,
          source: "GENERATED",
          license: "Royalty-free (procedurally generated)",
        },
      });
    });
  }
}

const providers: MusicProvider[] = [new LocalLibraryMusicProvider(), new ProceduralMusicProvider()];

export async function recentMusicTrackIds(userId: string, limit = 5): Promise<string[]> {
  const videos = await db.video.findMany({
    where: { userId, musicTrackId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { musicTrackId: true },
  });
  return videos.map((v) => v.musicTrackId!).filter(Boolean);
}

export function resolveMood(mode: string, plannedMood: string | null | undefined, preferredMoods: string[]): string | null {
  if (mode === "none") return null;
  if (mode !== "auto" && MOOD_PROFILES[mode]) return mode;
  if (plannedMood && MOOD_PROFILES[plannedMood]) return plannedMood;
  return preferredMoods.find((m) => MOOD_PROFILES[m]) ?? "documentary";
}

export async function selectMusic(opts: {
  userId: string;
  mode: string;
  plannedMood?: string | null;
  preferredMoods: string[];
  durationSec: number;
}): Promise<{ track: MusicTrack | null; mood: string | null; provider: string | null }> {
  const mood = resolveMood(opts.mode, opts.plannedMood, opts.preferredMoods);
  if (!mood) return { track: null, mood: null, provider: null };
  const avoidTrackIds = await recentMusicTrackIds(opts.userId);
  for (const provider of providers) {
    try {
      const track = await provider.findTrack({ userId: opts.userId, mood, minDurationSec: opts.durationSec, avoidTrackIds });
      if (track) return { track, mood, provider: provider.name };
    } catch (error) {
      log.warn({ provider: provider.name, err: (error as Error).message }, "music provider failed");
    }
  }
  return { track: null, mood, provider: null };
}

/** Returns storage keys of SFX variants, generating and caching them on first use. */
export async function ensureSfxLibrary(variants = 3): Promise<Record<SfxType, string[]>> {
  const library = {} as Record<SfxType, string[]>;
  for (const type of SFX_TYPES) {
    library[type] = [];
    for (let v = 1; v <= variants; v++) {
      const key = `sfx/generated/${type}-v${v}.wav`;
      const existing = await db.mediaAsset.findUnique({ where: { storageKey: key } });
      if (existing) {
        library[type].push(key);
        continue;
      }
      await withWorkDir("sfx", async (dir) => {
        const outputPath = path.join(dir, `${type}-${v}.wav`);
        await generateSfx({ type, seed: v * 104729 + type.length, outputPath });
        await storeAsset({
          kind: "AUDIO_SFX",
          key,
          mimeType: "audio/wav",
          source: "GENERATED",
          filePath: outputPath,
          probe: true,
          license: "Royalty-free: synthesised by Shorts Factory",
        });
      });
      library[type].push(key);
    }
  }
  return library;
}
