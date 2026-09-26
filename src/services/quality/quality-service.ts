import { ffmpeg, mediaInfo, type MediaInfo } from "@/services/video/ffmpeg";
import { OUTPUT_FPS, OUTPUT_HEIGHT, OUTPUT_WIDTH } from "@/services/video/render-engine";

/**
 * QualityControlService
 *
 * Purpose: verify a rendered Short before it can become READY.
 * Technical checks (FFprobe + a full FFmpeg decode pass):
 *   file decodes without errors, MP4 container, H.264 + AAC, 1080x1920, ~30 fps,
 *   duration matches the narration and is valid for Shorts, audio present and audible,
 *   no clipping, no long silences, no black frames.
 * Content checks: every scene has media and scenes cover the timeline, subtitles
 * exist and are English, voiceover transcript is English.
 * Output: QualityReport { passed, checks[] } stored on the video.
 */
export interface QualityCheck {
  name: string;
  passed: boolean;
  detail: string;
  retryable?: boolean;
}

export interface QualityReport {
  passed: boolean;
  checkedAt: string;
  checks: QualityCheck[];
  media?: MediaInfo;
}

export interface DecodeAnalysis {
  decodeErrors: string[];
  blackSegments: { start: number; end: number; duration: number }[];
  silenceSegments: { start: number; end: number; duration: number }[];
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
}

export function parseDecodeLog(stderr: string): DecodeAnalysis {
  const blackSegments = [...stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)].map((m) => ({
    start: Number(m[1]),
    end: Number(m[2]),
    duration: Number(m[3]),
  }));
  const silenceStarts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  const silenceEnds = [...stderr.matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)].map((m) => ({
    end: Number(m[1]),
    duration: Number(m[2]),
  }));
  const silenceSegments = silenceEnds.map((e, i) => ({ start: silenceStarts[i] ?? e.end - e.duration, end: e.end, duration: e.duration }));
  // A trailing silence without silence_end runs to the end of file.
  if (silenceStarts.length > silenceEnds.length) {
    const start = silenceStarts.at(-1)!;
    silenceSegments.push({ start, end: Number.NaN, duration: Number.NaN });
  }
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  const max = /max_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  const decodeErrors = stderr
    .split("\n")
    .filter((line) => /error|invalid|corrupt/i.test(line) && !/blackdetect|silencedetect|volumedetect/.test(line))
    .slice(0, 10);
  return {
    decodeErrors,
    blackSegments,
    silenceSegments,
    meanVolumeDb: mean ? Number(mean[1]) : null,
    maxVolumeDb: max ? Number(max[1]) : null,
  };
}

export async function analyzeDecode(filePath: string, signal?: AbortSignal): Promise<DecodeAnalysis> {
  const { stderr } = await ffmpeg(
    [
      "-v", "info", "-i", filePath,
      "-vf", "blackdetect=d=0.4:pix_th=0.08:pic_th=0.97",
      "-af", "silencedetect=n=-45dB:d=1.2,volumedetect",
      "-f", "null", "-",
    ],
    { timeoutMs: 10 * 60_000, signal },
  );
  return parseDecodeLog(stderr);
}

export interface TechnicalExpectations {
  expectedDurationSec: number;
  durationToleranceSec?: number;
  maxDurationSec?: number;
}

export function evaluateTechnical(info: MediaInfo, decode: DecodeAnalysis, expect: TechnicalExpectations): QualityCheck[] {
  const checks: QualityCheck[] = [];
  const tolerance = expect.durationToleranceSec ?? 1.0;
  const maxDuration = expect.maxDurationSec ?? 180;
  checks.push({ name: "decodable", passed: decode.decodeErrors.length === 0, detail: decode.decodeErrors.length ? decode.decodeErrors.join(" | ") : "decoded cleanly", retryable: true });
  checks.push({ name: "container", passed: Boolean(info.formatName?.includes("mp4")), detail: info.formatName ?? "unknown" });
  checks.push({ name: "codecs", passed: info.videoCodec === "h264" && info.audioCodec === "aac", detail: `${info.videoCodec ?? "none"}/${info.audioCodec ?? "none"}` });
  checks.push({ name: "resolution", passed: info.width === OUTPUT_WIDTH && info.height === OUTPUT_HEIGHT, detail: `${info.width}x${info.height}` });
  checks.push({ name: "fps", passed: Boolean(info.fps && Math.abs(info.fps - OUTPUT_FPS) < 0.2), detail: `${info.fps?.toFixed(2) ?? "?"} fps` });
  checks.push({ name: "pixel_format", passed: info.pixFmt === "yuv420p", detail: info.pixFmt ?? "unknown" });
  const durationOk = Math.abs(info.durationSec - expect.expectedDurationSec) <= tolerance && info.durationSec >= 5 && info.durationSec <= maxDuration;
  checks.push({ name: "duration", passed: durationOk, detail: `${info.durationSec.toFixed(2)}s (expected ${expect.expectedDurationSec.toFixed(2)}s, max ${maxDuration}s)`, retryable: true });
  checks.push({ name: "audio_present", passed: info.hasAudio, detail: info.hasAudio ? "audio stream present" : "no audio stream" });
  const audible = decode.meanVolumeDb !== null && decode.meanVolumeDb > -32;
  checks.push({ name: "audio_audible", passed: audible, detail: `mean ${decode.meanVolumeDb ?? "?"} dB` });
  const noClipping = decode.maxVolumeDb !== null && decode.maxVolumeDb <= -0.05;
  checks.push({ name: "audio_no_clipping", passed: noClipping, detail: `peak ${decode.maxVolumeDb ?? "?"} dB`, retryable: true });
  const silence = decode.silenceSegments.reduce((sum, s) => sum + (Number.isFinite(s.duration) ? s.duration : 0), 0);
  const longestSilence = Math.max(0, ...decode.silenceSegments.map((s) => (Number.isFinite(s.duration) ? s.duration : 0)));
  checks.push({ name: "audio_no_long_silence", passed: longestSilence < 3 && silence < info.durationSec * 0.2, detail: `longest silence ${longestSilence.toFixed(1)}s, total ${silence.toFixed(1)}s` });
  const blackTotal = decode.blackSegments.reduce((sum, s) => sum + s.duration, 0);
  const longestBlack = Math.max(0, ...decode.blackSegments.map((s) => s.duration));
  checks.push({ name: "no_black_frames", passed: longestBlack < 0.8 && blackTotal < info.durationSec * 0.05, detail: decode.blackSegments.length ? `${decode.blackSegments.length} black segment(s), longest ${longestBlack.toFixed(2)}s` : "no black frames", retryable: true });
  return checks;
}

export interface ContentExpectations {
  scenes: { index: number; startSec: number; endSec: number; hasMedia: boolean }[];
  totalDurationSec: number;
  subtitleCueCount: number;
  subtitleEnglish: boolean;
  voiceoverEnglish: boolean;
}

export function evaluateContent(expect: ContentExpectations): QualityCheck[] {
  const checks: QualityCheck[] = [];
  const missing = expect.scenes.filter((s) => !s.hasMedia).map((s) => s.index + 1);
  checks.push({ name: "scenes_have_media", passed: expect.scenes.length > 0 && missing.length === 0, detail: missing.length ? `scenes without media: ${missing.join(", ")}` : `${expect.scenes.length} scenes` });
  const sorted = [...expect.scenes].sort((a, b) => a.index - b.index);
  const gaps = sorted.slice(1).filter((s, i) => Math.abs(s.startSec - sorted[i]!.endSec) > 0.05);
  const coversEnd = sorted.length > 0 && sorted.at(-1)!.endSec >= expect.totalDurationSec - 0.5;
  checks.push({ name: "scenes_cover_timeline", passed: gaps.length === 0 && coversEnd, detail: gaps.length ? `${gaps.length} gap(s) between scenes` : coversEnd ? "continuous" : "scenes end before narration" });
  checks.push({ name: "subtitles_exist", passed: expect.subtitleCueCount > 0, detail: `${expect.subtitleCueCount} cues` });
  checks.push({ name: "subtitles_english", passed: expect.subtitleEnglish, detail: expect.subtitleEnglish ? "English" : "non-English subtitle text detected" });
  checks.push({ name: "voiceover_english", passed: expect.voiceoverEnglish, detail: expect.voiceoverEnglish ? "English" : "voiceover transcript is not English" });
  return checks;
}

export async function runQualityChecks(opts: {
  filePath: string;
  technical: TechnicalExpectations;
  content: ContentExpectations;
  signal?: AbortSignal;
}): Promise<QualityReport> {
  const info = await mediaInfo(opts.filePath, { signal: opts.signal });
  const decode = await analyzeDecode(opts.filePath, opts.signal);
  const checks = [...evaluateTechnical(info, decode, opts.technical), ...evaluateContent(opts.content)];
  return { passed: checks.every((c) => c.passed), checkedAt: new Date().toISOString(), checks, media: info };
}
