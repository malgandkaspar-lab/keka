import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { VideoStyle } from "@/config/templates";
import { MediaProcessingError } from "@/lib/errors";
import { ffmpeg, mediaInfo } from "./ffmpeg";

/**
 * RenderEngine - FFmpeg-based editor that produces the final YouTube Short.
 *
 * Output contract: MP4 (H.264 High, yuv420p, 30 fps, 1080x1920) + AAC 48 kHz stereo,
 * `+faststart` for streaming, loudness normalised to YouTube's -14 LUFS target.
 *
 * Pipeline:
 *   1. Scene segments: each scene's clip (or still image) is trimmed to the exact
 *      narration timing, cropped intelligently to 9:16 (with a slow pan across
 *      landscape footage), animated with a subtle zoom in/out, colour graded and
 *      normalised to 1080x1920@30.
 *   2. Assembly: segments are joined with the template's transitions (xfade) or hard
 *      cuts, then subtitles (ASS) and optional vignette are burned in.
 *   3. Audio: voiceover normalised; music loudness-normalised, set to ~8-15% and
 *      automatically ducked under the voice (sidechain compression); sparse sound
 *      effects placed at transitions; final limiter + loudness normalisation.
 *   4. Mux video + audio.
 */
export const OUTPUT_WIDTH = 1080;
export const OUTPUT_HEIGHT = 1920;
export const OUTPUT_FPS = 30;

export interface RenderScene {
  index: number;
  start: number;
  end: number;
  mediaPath: string;
  mediaKind: "video" | "image";
  mediaDurationSec: number;
  transition: string;
}

export interface RenderSfx {
  path: string;
  atSec: number;
  volume: number;
}

export interface RenderInput {
  scenes: RenderScene[];
  voicePath: string;
  voiceDurationSec: number;
  musicPath: string | null;
  musicVolume: number;
  ducking: boolean;
  sfx: RenderSfx[];
  assPath: string | null;
  fontsDir: string;
  style: VideoStyle;
  outputPath: string;
  workDir: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number, stage: string) => void;
}

export interface RenderOutput {
  outputPath: string;
  durationSec: number;
  /** Clean (subtitle-free) scene segments, useful for thumbnail frames. */
  segments: { path: string; durationSec: number }[];
}

const COLOR_GRADES: Record<VideoStyle["colorGrade"], string | null> = {
  none: null,
  vivid: "eq=saturation=1.22:contrast=1.06:brightness=0.01",
  cinematic: "eq=saturation=0.92:contrast=1.08,colorbalance=rs=-0.02:bs=0.04:rh=0.04:bh=-0.03",
  clean: "eq=contrast=1.03:saturation=1.05",
};

const X264_ARGS = ["-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(OUTPUT_FPS)];

function fmt(n: number): string {
  return n.toFixed(3);
}

/** Escapes a path for use inside an FFmpeg filter argument. */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

export function usesCrossfade(style: VideoStyle): boolean {
  return style.transition !== "cut" && style.transitionDurationSec > 0;
}

/** Builds the per-scene video filter (crop to 9:16, pan, zoom, grade). */
export function sceneFilter(opts: { durationSec: number; zoom: number; zoomIn: boolean; pan: boolean; grade: string | null; slowdown: number }): string {
  const d = Math.max(0.1, opts.durationSec);
  const z0 = opts.zoomIn ? 1 : 1 + opts.zoom;
  const z1 = opts.zoomIn ? 1 + opts.zoom : 1;
  const panStart = opts.zoomIn ? 0.35 : 0.65;
  const panEnd = opts.pan ? (opts.zoomIn ? 0.65 : 0.35) : panStart;
  const parts = [
    opts.slowdown > 1.001 ? `setpts=${opts.slowdown.toFixed(4)}*PTS` : null,
    `fps=${OUTPUT_FPS}`,
    `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:x='(iw-${OUTPUT_WIDTH})*(${panStart}+(${fmt(panEnd - panStart)})*min(t/${fmt(d)}\\,1))':y='(ih-${OUTPUT_HEIGHT})/2'`,
    opts.zoom > 0
      ? `scale=w='2*trunc(${OUTPUT_WIDTH}*(${fmt(z0)}+(${fmt(z1 - z0)})*min(t/${fmt(d)}\\,1))/2)':h=-2:eval=frame:flags=bicubic,crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}`
      : null,
    opts.grade,
    "setsar=1",
    "format=yuv420p",
  ];
  return parts.filter(Boolean).join(",");
}

async function renderSegment(scene: RenderScene, durationSec: number, offsetSec: number, input: RenderInput, outPath: string): Promise<void> {
  const isImage = scene.mediaKind === "image";
  const zoom = isImage ? Math.max(0.08, input.style.zoomAmount * 1.4) : input.style.zoomAmount;
  let slowdown = 1;
  let loop = false;
  if (!isImage && scene.mediaDurationSec > 0 && scene.mediaDurationSec < durationSec + offsetSec) {
    const ratio = durationSec / Math.max(0.1, scene.mediaDurationSec);
    if (ratio <= 1.5) slowdown = ratio + 0.02;
    else loop = true;
  }
  const filter = sceneFilter({
    durationSec,
    zoom,
    zoomIn: scene.index % 2 === 0,
    pan: input.style.panEnabled || isImage,
    grade: COLOR_GRADES[input.style.colorGrade],
    slowdown,
  });
  const inputArgs = isImage
    ? ["-loop", "1", "-framerate", String(OUTPUT_FPS), "-t", fmt(durationSec), "-i", scene.mediaPath]
    : [...(loop ? ["-stream_loop", "-1"] : []), ...(offsetSec > 0 && !loop && slowdown === 1 ? ["-ss", fmt(offsetSec)] : []), "-i", scene.mediaPath];
  await ffmpeg(
    [...inputArgs, "-t", fmt(durationSec), "-an", "-vf", filter, ...X264_ARGS, "-preset", "veryfast", "-crf", "17", outPath],
    { timeoutMs: 5 * 60_000, signal: input.signal },
  );
}

/** Chooses a start offset inside the source so reused clips show different footage. */
function sourceOffset(scene: RenderScene, durationSec: number, usage: Map<string, number>): number {
  const used = usage.get(scene.mediaPath) ?? 0;
  usage.set(scene.mediaPath, used + 1);
  if (scene.mediaKind === "image") return 0;
  const available = scene.mediaDurationSec - durationSec;
  if (available <= 0.2) return 0;
  const lead = Math.min(0.5, available);
  return Math.min(available, lead + ((used * durationSec) % Math.max(0.1, available - lead)));
}

export function buildXfadeGraph(durations: number[], transitions: string[], td: number): { filter: string; output: string } {
  if (durations.length === 1) return { filter: "[0:v]null[vcat]", output: "[vcat]" };
  const parts: string[] = [];
  let previous = "[0:v]";
  let offset = 0;
  for (let i = 1; i < durations.length; i++) {
    offset += durations[i - 1]!;
    const label = i === durations.length - 1 ? "[vcat]" : `[vx${i}]`;
    const transition = transitions[i] && transitions[i] !== "cut" ? transitions[i]! : "fade";
    parts.push(`${previous}[${i}:v]xfade=transition=${transition}:duration=${fmt(td)}:offset=${fmt(offset)}${label}`);
    previous = label;
  }
  return { filter: parts.join(";"), output: "[vcat]" };
}

async function assembleVideo(segmentPaths: string[], sceneDurations: number[], input: RenderInput, outPath: string, totalSec: number): Promise<void> {
  const crossfade = usesCrossfade(input.style) && segmentPaths.length > 1;
  const overlays: string[] = [];
  if (input.style.vignette) overlays.push("vignette=angle=PI/5");
  if (input.assPath) overlays.push(`ass='${escapeFilterPath(input.assPath)}':fontsdir='${escapeFilterPath(input.fontsDir)}'`);
  overlays.push("format=yuv420p");

  let graph: string;
  if (crossfade) {
    const transitions = input.scenes.map((s) => s.transition);
    const { filter, output } = buildXfadeGraph(sceneDurations, transitions, input.style.transitionDurationSec);
    graph = `${filter};${output}${overlays.join(",")}[vout]`;
  } else {
    const inputs = segmentPaths.map((_, i) => `[${i}:v]`).join("");
    graph = `${inputs}concat=n=${segmentPaths.length}:v=1:a=0,${overlays.join(",")}[vout]`;
  }
  const inputArgs = segmentPaths.flatMap((p) => ["-i", p]);
  await ffmpeg(
    [...inputArgs, "-filter_complex", graph, "-map", "[vout]", "-t", fmt(totalSec), ...X264_ARGS, "-preset", "medium", "-crf", "20", "-g", String(OUTPUT_FPS * 2), "-movflags", "+faststart", outPath],
    {
      timeoutMs: 15 * 60_000,
      signal: input.signal,
      onProgress: (sec) => input.onProgress?.(0.55 + 0.3 * Math.min(1, sec / totalSec), "assembling"),
    },
  );
}

/** Builds the audio mix filter graph: voice + ducked music + SFX, limited and normalised. */
export function buildAudioGraph(opts: { hasMusic: boolean; musicVolume: number; ducking: boolean; sfx: RenderSfx[]; totalSec: number }): string {
  const parts: string[] = [];
  const total = fmt(opts.totalSec);
  parts.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=0:${total}[voice]`);
  const mix: string[] = [];
  if (opts.hasMusic) {
    parts.push("[voice]asplit=2[voicemix][voicekey]");
    parts.push(
      `[1:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${total},asetpts=N/SR/TB,loudnorm=I=-16:TP=-2:LRA=9,volume=${opts.musicVolume.toFixed(3)},` +
        `afade=t=in:d=0.8,afade=t=out:st=${fmt(Math.max(0, opts.totalSec - 1.5))}:d=1.5[musicraw]`,
    );
    if (opts.ducking) {
      parts.push("[musicraw][voicekey]sidechaincompress=threshold=0.025:ratio=6:attack=15:release=350:makeup=1[music]");
    } else {
      parts.push("[voicekey]anullsink");
      parts.push("[musicraw]anull[music]");
    }
    mix.push("[voicemix]", "[music]");
  } else {
    mix.push("[voice]");
  }
  const sfxOffset = opts.hasMusic ? 2 : 1;
  opts.sfx.forEach((effect, i) => {
    const delayMs = Math.max(0, Math.round(effect.atSec * 1000));
    parts.push(`[${sfxOffset + i}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${effect.volume.toFixed(3)},adelay=${delayMs}|${delayMs}[sfx${i}]`);
    mix.push(`[sfx${i}]`);
  });
  parts.push(
    `${mix.join("")}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0,` +
      `alimiter=limit=0.89:level=false,loudnorm=I=-14:TP=-1.0:LRA=11,aresample=48000,atrim=0:${total}[aout]`,
  );
  return parts.join(";");
}

async function mixAudio(input: RenderInput, outPath: string, totalSec: number): Promise<void> {
  const args = ["-i", input.voicePath];
  if (input.musicPath) args.push("-stream_loop", "-1", "-i", input.musicPath);
  for (const effect of input.sfx) args.push("-i", effect.path);
  const graph = buildAudioGraph({
    hasMusic: Boolean(input.musicPath),
    musicVolume: input.musicVolume,
    ducking: input.ducking,
    sfx: input.sfx,
    totalSec,
  });
  await ffmpeg([...args, "-filter_complex", graph, "-map", "[aout]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", outPath], {
    timeoutMs: 5 * 60_000,
    signal: input.signal,
  });
}

export async function renderVideo(input: RenderInput): Promise<RenderOutput> {
  if (input.scenes.length === 0) throw new MediaProcessingError("Cannot render a video without scenes", {}, false);
  const scenes = [...input.scenes].sort((a, b) => a.index - b.index);
  const totalSec = Number(Math.max(scenes.at(-1)!.end, input.voiceDurationSec + 0.3).toFixed(3));
  const crossfade = usesCrossfade(input.style) && scenes.length > 1;
  const td = crossfade ? input.style.transitionDurationSec : 0;

  // Scene durations laid end to end must equal the total duration.
  const sceneDurations = scenes.map((scene, i) => {
    const next = scenes[i + 1];
    const end = next ? next.start : totalSec;
    return Math.max(0.2, end - (i === 0 ? 0 : scene.start));
  });

  const usage = new Map<string, number>();
  const segmentPaths: string[] = [];
  for (const [i, scene] of scenes.entries()) {
    const extra = crossfade && i < scenes.length - 1 ? td : 0;
    const duration = sceneDurations[i]! + extra;
    const segmentPath = path.join(input.workDir, `segment-${String(i).padStart(3, "0")}.mp4`);
    await renderSegment(scene, duration, sourceOffset(scene, duration, usage), input, segmentPath);
    segmentPaths.push(segmentPath);
    input.onProgress?.(0.05 + 0.5 * ((i + 1) / scenes.length), "segments");
  }

  const videoPath = path.join(input.workDir, "video.mp4");
  await assembleVideo(segmentPaths, sceneDurations, { ...input, scenes }, videoPath, totalSec);

  const audioPath = path.join(input.workDir, "audio.m4a");
  input.onProgress?.(0.88, "audio");
  await mixAudio(input, audioPath, totalSec);

  input.onProgress?.(0.95, "muxing");
  await ffmpeg(
    ["-i", videoPath, "-i", audioPath, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-t", fmt(totalSec), "-movflags", "+faststart", "-shortest", input.outputPath],
    { timeoutMs: 2 * 60_000, signal: input.signal },
  );
  const info = await mediaInfo(input.outputPath);
  await writeFile(path.join(input.workDir, "render.json"), JSON.stringify({ totalSec, sceneDurations, info }, null, 2));
  input.onProgress?.(1, "done");
  return {
    outputPath: input.outputPath,
    durationSec: info.durationSec,
    segments: segmentPaths.map((p, i) => ({ path: p, durationSec: sceneDurations[i]! })),
  };
}
