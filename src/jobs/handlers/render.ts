import path from "node:path";
import { getEnv } from "@/config/env";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { stableHash } from "@/lib/crypto";
import { MediaProcessingError, QualityCheckError, ValidationError } from "@/lib/errors";
import { withWorkDir } from "@/lib/workdir";
import { analyzeLanguage } from "@/services/language/language-service";
import { storeAsset } from "@/services/media/media-service";
import { ensureSfxLibrary } from "@/services/music/music-service";
import { runQualityChecks } from "@/services/quality/quality-service";
import { materialize } from "@/services/storage";
import { currentSubtitle } from "@/services/subtitles/subtitle-service";
import { createThumbnail, extractCandidateFrames, mostDetailedFrame } from "@/services/thumbnail/thumbnail-service";
import { currentVoiceover } from "@/services/tts/voiceover-service";
import { renderVideo, type RenderScene, type RenderSfx } from "@/services/video/render-engine";
import { loadVideoContext } from "../context";
import type { StepHandler } from "../types";

/** Render steps: FFmpeg render, quality control and thumbnail. */
const MAX_RENDER_REROUTES = 1;

function pick<T>(items: T[], seed: string): T | undefined {
  if (items.length === 0) return undefined;
  const n = parseInt(stableHash(seed).slice(0, 8), 16);
  return items[n % items.length];
}

/** Sparse, varied sound design: an intro hit, a few whooshes, maybe a riser before the payoff. */
export function planSoundEffects(opts: {
  videoId: string;
  sceneStarts: number[];
  totalSec: number;
  library: Record<string, string[]>;
  paths: Map<string, string>;
  intro: boolean;
  transitions: boolean;
  volume: number;
}): RenderSfx[] {
  const effects: RenderSfx[] = [];
  const at = (type: string, sec: number, gain: number, salt: string) => {
    const key = pick(opts.library[type] ?? [], `${opts.videoId}:${salt}`);
    const file = key ? opts.paths.get(key) : undefined;
    if (file) effects.push({ path: file, atSec: Math.max(0, sec), volume: opts.volume * gain });
  };
  if (opts.intro) at("impact", 0.05, 1, "intro");
  if (opts.transitions) {
    const boundaries = opts.sceneStarts.slice(1);
    const chosen = boundaries.filter((_, i) => i % 3 === 1).slice(0, 4);
    chosen.forEach((sec, i) => at("whoosh", sec - 0.25, 0.8, `whoosh-${i}`));
  }
  if (opts.totalSec > 20 && opts.sceneStarts.length > 3) {
    const payoffStart = opts.sceneStarts.at(-1)!;
    if (parseInt(stableHash(`${opts.videoId}:riser`).slice(0, 2), 16) % 2 === 0) at("riser", payoffStart - 1.1, 0.5, "riser");
  }
  return effects;
}

export const renderVideoHandler: StepHandler = async (ctx) => {
  const { video, settings, template } = await loadVideoContext(ctx.videoId);
  const env = getEnv();
  const scenes = await db.videoScene.findMany({ where: { videoId: video.id }, include: { mediaAsset: true }, orderBy: { index: "asc" } });
  if (scenes.length === 0) throw new ValidationError("Video has no scenes");
  const missing = scenes.filter((s) => !s.mediaAsset);
  if (missing.length) throw new ValidationError(`Scenes without footage: ${missing.map((s) => s.index + 1).join(", ")}`);
  const voiceover = await currentVoiceover(video.id);
  const subtitle = await currentSubtitle(video.id);
  if (!subtitle?.asset) throw new ValidationError("Subtitles have not been generated");
  const music = video.musicTrackId ? await db.musicTrack.findUnique({ where: { id: video.musicTrackId }, include: { asset: true } }) : null;

  return withWorkDir(`render-${video.id}`, async (workDir) => {
    await ctx.progress(3, "Preparing media");
    const renderScenes: RenderScene[] = [];
    for (const scene of scenes) {
      const asset = scene.mediaAsset!;
      renderScenes.push({
        index: scene.index,
        start: scene.startSec,
        end: scene.endSec,
        mediaPath: await materialize(asset.storageKey, workDir),
        mediaKind: asset.kind === "IMAGE" ? "image" : "video",
        mediaDurationSec: asset.durationSec ?? 0,
        transition: scene.transition,
      });
    }
    const voicePath = await materialize(voiceover.asset.storageKey, workDir);
    const musicPath = music ? await materialize(music.asset.storageKey, workDir) : null;
    const assPath = await materialize(subtitle.asset!.storageKey, workDir);

    let sfx: RenderSfx[] = [];
    if (video.sfxEnabled && settings.sfxEnabled && (template.audio.sfxTransitions || template.audio.sfxIntroImpact)) {
      const library = await ensureSfxLibrary();
      const paths = new Map<string, string>();
      for (const key of Object.values(library).flat()) paths.set(key, await materialize(key, workDir));
      sfx = planSoundEffects({
        videoId: video.id,
        sceneStarts: renderScenes.map((s) => s.start),
        totalSec: voiceover.durationSec,
        library,
        paths,
        intro: template.audio.sfxIntroImpact,
        transitions: template.audio.sfxTransitions,
        volume: template.audio.sfxVolume,
      });
    }

    const outputPath = path.join(workDir, "final.mp4");
    const result = await renderVideo({
      scenes: renderScenes,
      voicePath,
      voiceDurationSec: voiceover.durationSec,
      musicPath,
      musicVolume: Math.min(settings.musicVolume, template.audio.musicVolume) || template.audio.musicVolume,
      ducking: template.audio.duckingEnabled,
      sfx,
      assPath,
      fontsDir: env.FONTS_DIR,
      style: template.video,
      outputPath,
      workDir,
      signal: ctx.signal,
      onProgress: (fraction, stage) => void ctx.progress(Math.round(fraction * 100), stage),
    });

    const stamp = Date.now();
    const asset = await storeAsset({
      userId: video.userId,
      kind: "RENDER",
      key: `videos/${video.id}/render/${stamp}.mp4`,
      mimeType: "video/mp4",
      source: "RENDERED",
      filePath: result.outputPath,
      probe: true,
      metadata: { scenes: scenes.length, sfx: sfx.length, music: music?.title ?? null } as Prisma.InputJsonValue,
    });

    // Clean frames (without subtitles) for the thumbnail step.
    const frames = await extractCandidateFrames(result.segments, workDir);
    const baseFrame = await mostDetailedFrame(frames);
    const frameAsset = await storeAsset({
      userId: video.userId,
      kind: "OTHER",
      key: `videos/${video.id}/frames/${stamp}.jpg`,
      mimeType: "image/jpeg",
      source: "RENDERED",
      filePath: baseFrame,
    });

    await db.video.update({ where: { id: video.id }, data: { renderAssetId: asset.id, actualDurationSec: result.durationSec } });
    return {
      provider: "ffmpeg",
      message: `Video rendered (${result.durationSec.toFixed(1)}s, ${scenes.length} scenes, 1080x1920)`,
      output: { renderAssetId: asset.id, baseFrameKey: frameAsset.storageKey, durationSec: result.durationSec, sfx: sfx.length },
    };
  });
};

export const qualityCheckHandler: StepHandler = async (ctx) => {
  const { video } = await loadVideoContext(ctx.videoId);
  if (!video.renderAssetId) throw new ValidationError("Video has not been rendered");
  const render = await db.mediaAsset.findUniqueOrThrow({ where: { id: video.renderAssetId } });
  const voiceover = await currentVoiceover(video.id);
  const subtitle = await currentSubtitle(video.id);
  const scenes = await db.videoScene.findMany({ where: { videoId: video.id } });
  const cues = (subtitle?.cues as { lines: string[][] }[] | undefined) ?? [];
  const subtitleText = cues.map((c) => c.lines.flat().join(" ")).join(" ");
  const expectedDuration = Math.max(scenes.reduce((m, s) => Math.max(m, s.endSec), 0), voiceover.durationSec + 0.3);

  return withWorkDir(`qc-${video.id}`, async (workDir) => {
    const filePath = await materialize(render.storageKey, workDir);
    await ctx.progress(20, "Decoding and analysing the render");
    const report = await runQualityChecks({
      filePath,
      technical: { expectedDurationSec: expectedDuration, maxDurationSec: 180 },
      content: {
        scenes: scenes.map((s) => ({ index: s.index, startSec: s.startSec, endSec: s.endSec, hasMedia: Boolean(s.mediaAssetId) })),
        totalDurationSec: voiceover.durationSec,
        subtitleCueCount: cues.length,
        subtitleEnglish: subtitleText ? analyzeLanguage(subtitleText, "subtitles").isEnglish : false,
        voiceoverEnglish: subtitle
          ? (subtitle.detectedLanguage ?? "en").toLowerCase().startsWith("en") && analyzeLanguage(subtitle.transcript, "subtitles").isEnglish
          : false,
      },
      signal: ctx.signal,
    });
    await db.video.update({ where: { id: video.id }, data: { qualityReport: JSON.parse(JSON.stringify(report)) } });
    const failed = report.checks.filter((c) => !c.passed);
    if (failed.length === 0) return { message: "Quality check passed", output: { checks: report.checks.length } };

    const summary = failed.map((c) => `${c.name} (${c.detail})`).join("; ");
    const renders = await db.generationJob.count({ where: { videoId: video.id, step: "RENDER_VIDEO" } });
    if (failed.every((c) => c.retryable) && renders <= MAX_RENDER_REROUTES) {
      return { reroute: { step: "RENDER_VIDEO", reason: `quality check failed: ${summary}` }, output: { failed: failed.map((c) => c.name) } };
    }
    throw new QualityCheckError(`Quality check failed: ${summary}`, { failed: failed.map((c) => c.name) });
  });
};

export const generateThumbnailHandler: StepHandler = async (ctx) => {
  const { video } = await loadVideoContext(ctx.videoId);
  const renderJob = await db.generationJob.findFirst({
    where: { videoId: video.id, step: "RENDER_VIDEO", status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
  });
  const baseFrameKey = (renderJob?.output as { baseFrameKey?: string } | null)?.baseFrameKey;
  if (!baseFrameKey) throw new MediaProcessingError("No base frame available from the render", {}, false);
  return withWorkDir(`thumb-${video.id}`, async (workDir) => {
    const baseFramePath = await materialize(baseFrameKey, workDir);
    const output = await createThumbnail({
      baseFramePath,
      text: video.thumbnailText,
      fontFile: path.join(getEnv().FONTS_DIR, "dejavu", "DejaVuSans-Bold.ttf"),
      workDir,
    });
    const asset = await storeAsset({
      userId: video.userId,
      kind: "THUMBNAIL",
      key: `videos/${video.id}/thumbnail/${Date.now()}.jpg`,
      mimeType: "image/jpeg",
      source: "RENDERED",
      filePath: output,
    });
    await db.video.update({ where: { id: video.id }, data: { thumbnailAssetId: asset.id } });
    return { provider: "ffmpeg", message: "Thumbnail created", output: { thumbnailAssetId: asset.id } };
  });
};
