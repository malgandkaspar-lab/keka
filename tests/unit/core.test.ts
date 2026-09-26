import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, stableHash } from "@/lib/crypto";
import { computeNextRun, zonedTimeToUtc } from "@/services/publishing/scheduler-service";
import { createOAuthState, privacyForUpload, verifyOAuthState } from "@/services/youtube/youtube-service";
import { parseDecodeLog, evaluateTechnical, evaluateContent } from "@/services/quality/quality-service";
import { buildAudioGraph, buildXfadeGraph, sceneFilter } from "@/services/video/render-engine";
import { pickBestFile, rankCandidates } from "@/services/footage/footage-service";
import { planSoundEffects } from "@/jobs/handlers/render";
import { dependentSteps, GENERATION_STEPS, nextStepAfter, STEP_DEFINITIONS, stepTimeoutMs } from "@/services/pipeline/steps";
import { AuthenticationError, ValidationError } from "@/lib/errors";
import type { FootageCandidate } from "@/services/footage/types";

describe("crypto", () => {
  it("encrypts secrets with authenticated encryption", () => {
    const encrypted = encryptSecret("refresh-token-value");
    expect(encrypted).not.toContain("refresh-token-value");
    expect(decryptSecret(encrypted)).toBe("refresh-token-value");
    const tampered = encrypted.slice(0, -4) + "AAAA";
    expect(() => decryptSecret(tampered)).toThrow();
    expect(stableHash({ b: 1, a: 2 })).toBe(stableHash({ a: 2, b: 1 }));
  });
});

describe("YouTube OAuth state and privacy", () => {
  it("binds state to the user and nonce", () => {
    const { state, nonce } = createOAuthState("user-1");
    expect(() => verifyOAuthState(state, "user-1", nonce)).not.toThrow();
    expect(() => verifyOAuthState(state, "user-2", nonce)).toThrow(AuthenticationError);
    expect(() => verifyOAuthState(state, "user-1", "wrong")).toThrow(AuthenticationError);
    expect(() => verifyOAuthState(`${state}x`, "user-1", nonce)).toThrow(AuthenticationError);
  });

  it("maps privacy options, requiring a future time for scheduled uploads", () => {
    expect(privacyForUpload("PUBLIC", null)).toEqual({ privacyStatus: "public", publishAt: null });
    const when = new Date(Date.now() + 3600_000);
    expect(privacyForUpload("SCHEDULED", when)).toEqual({ privacyStatus: "private", publishAt: when });
    expect(() => privacyForUpload("SCHEDULED", null)).toThrow(ValidationError);
    expect(() => privacyForUpload("SCHEDULED", new Date(Date.now() - 1000))).toThrow(ValidationError);
  });
});

describe("scheduler", () => {
  it("computes the next run in the schedule's time zone (DST safe)", () => {
    const utc = zonedTimeToUtc(2026, 7, 1, 9, 0, "Europe/Tallinn");
    expect(utc.toISOString()).toBe("2026-07-01T06:00:00.000Z");
    const winter = zonedTimeToUtc(2026, 1, 15, 9, 0, "Europe/Tallinn");
    expect(winter.toISOString()).toBe("2026-01-15T07:00:00.000Z");
    const next = computeNextRun({ daysOfWeek: [1, 3, 5], times: ["16:00"], timezone: "UTC" }, new Date("2026-09-26T12:00:00Z"));
    expect(next?.toISOString()).toBe("2026-09-28T16:00:00.000Z");
    const twice = computeNextRun({ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], times: ["18:00", "10:00"], timezone: "UTC" }, new Date("2026-09-26T12:00:00Z"));
    expect(twice?.toISOString()).toBe("2026-09-26T18:00:00.000Z");
  });
});

describe("quality control", () => {
  const info = { durationSec: 30.2, width: 1080, height: 1920, fps: 30, hasVideo: true, hasAudio: true, videoCodec: "h264", audioCodec: "aac", formatName: "mov,mp4,m4a,3gp,3g2,mj2", pixFmt: "yuv420p" };

  it("parses black frames, silence and loudness from FFmpeg output", () => {
    const parsed = parseDecodeLog(
      "[blackdetect @ 0x] black_start:3.2 black_end:4.5 black_duration:1.3\n[silencedetect @ 0x] silence_start: 10.0\n[silencedetect @ 0x] silence_end: 12.5 | silence_duration: 2.5\n[Parsed_volumedetect_1 @ 0x] mean_volume: -18.2 dB\n[Parsed_volumedetect_1 @ 0x] max_volume: -1.2 dB\n",
    );
    expect(parsed.blackSegments).toEqual([{ start: 3.2, end: 4.5, duration: 1.3 }]);
    expect(parsed.silenceSegments[0]).toEqual({ start: 10, end: 12.5, duration: 2.5 });
    expect(parsed.meanVolumeDb).toBe(-18.2);
    const checks = evaluateTechnical(info, parsed, { expectedDurationSec: 30 });
    expect(checks.find((c) => c.name === "no_black_frames")!.passed).toBe(false);
    expect(checks.find((c) => c.name === "resolution")!.passed).toBe(true);
  });

  it("fails wrong resolution, silent audio and missing scenes", () => {
    const decode = { decodeErrors: [], blackSegments: [], silenceSegments: [], meanVolumeDb: -60, maxVolumeDb: -40 };
    const checks = evaluateTechnical({ ...info, width: 1920, height: 1080 }, decode, { expectedDurationSec: 30 });
    expect(checks.find((c) => c.name === "resolution")!.passed).toBe(false);
    expect(checks.find((c) => c.name === "audio_audible")!.passed).toBe(false);
    const content = evaluateContent({ scenes: [{ index: 0, startSec: 0, endSec: 10, hasMedia: true }, { index: 1, startSec: 10, endSec: 30, hasMedia: false }], totalDurationSec: 30, subtitleCueCount: 5, subtitleEnglish: true, voiceoverEnglish: false });
    expect(content.find((c) => c.name === "scenes_have_media")!.passed).toBe(false);
    expect(content.find((c) => c.name === "voiceover_english")!.passed).toBe(false);
  });
});

describe("render graph", () => {
  it("chains xfade transitions at cumulative offsets", () => {
    const { filter } = buildXfadeGraph([3, 4, 5], ["cut", "fade", "slideleft"], 0.3);
    expect(filter).toContain("xfade=transition=fade:duration=0.300:offset=3.000");
    expect(filter).toContain("xfade=transition=slideleft:duration=0.300:offset=7.000");
  });

  it("crops to 9:16 with zoom and pan", () => {
    const filter = sceneFilter({ durationSec: 3, zoom: 0.1, zoomIn: true, pan: true, grade: null, slowdown: 1 });
    expect(filter).toContain("scale=1080:1920:force_original_aspect_ratio=increase");
    expect(filter).toContain("crop=1080:1920");
    expect(filter).toContain("eval=frame");
  });

  it("ducks music under the voice and normalises loudness", () => {
    const graph = buildAudioGraph({ hasMusic: true, musicVolume: 0.12, ducking: true, sfx: [{ path: "x.wav", atSec: 1.5, volume: 0.3 }], totalSec: 30 });
    expect(graph).toContain("sidechaincompress");
    expect(graph).toContain("volume=0.120");
    expect(graph).toContain("adelay=1500|1500");
    expect(graph).toContain("loudnorm=I=-14");
  });

  it("uses sound effects sparingly", () => {
    const paths = new Map([["impact", "/i.wav"], ["whoosh", "/w.wav"], ["riser", "/r.wav"]]);
    const sfx = planSoundEffects({ videoId: "v1", sceneStarts: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22], totalSec: 30, library: { impact: ["impact"], whoosh: ["whoosh"], riser: ["riser"] }, paths, intro: true, transitions: true, volume: 0.3 });
    expect(sfx.filter((s) => s.path === "/w.wav").length).toBeLessThanOrEqual(4);
    expect(sfx.length).toBeLessThan(12);
  });
});

describe("footage ranking", () => {
  const make = (id: string, width: number, height: number, durationSec: number, rank: number): FootageCandidate => ({
    provider: "pexels", kind: "video", id, pageUrl: "", width, height, durationSec, author: "a", license: "Pexels License", licenseUrl: "", query: "q", rank,
    files: [{ url: `https://videos.pexels.com/${id}.mp4`, width, height }],
  });

  it("prefers vertical, high-resolution, long-enough and unused clips", () => {
    const ranked = rankCandidates([make("land", 1920, 1080, 10, 0), make("vert", 1080, 1920, 10, 1), make("short", 1080, 1920, 1, 0), make("used", 1080, 1920, 10, 0)], {
      sceneDurationSec: 3,
      usedInVideo: new Set(["used"]),
      usedRecently: new Set(),
    });
    expect(ranked[0]!.candidate.id).toBe("vert");
    expect(ranked.at(-1)!.candidate.id).toBe("used");
  });

  it("picks the smallest file that covers 1080x1920", () => {
    const file = pickBestFile([{ url: "4k", width: 2160, height: 3840 }, { url: "hd", width: 1080, height: 1920 }, { url: "sd", width: 540, height: 960 }], true);
    expect(file?.url).toBe("hd");
  });
});

describe("step timeouts", () => {
  it("gives AI steps more time on a local model, but not media steps", () => {
    expect(stepTimeoutMs(STEP_DEFINITIONS.RESEARCH_TOPIC, "ollama")).toBe(STEP_DEFINITIONS.RESEARCH_TOPIC.timeoutMs * 4);
    expect(stepTimeoutMs(STEP_DEFINITIONS.RESEARCH_TOPIC, "anthropic")).toBe(STEP_DEFINITIONS.RESEARCH_TOPIC.timeoutMs);
    expect(stepTimeoutMs(STEP_DEFINITIONS.RENDER_VIDEO, "ollama")).toBe(STEP_DEFINITIONS.RENDER_VIDEO.timeoutMs);
  });
});

describe("pipeline steps", () => {
  it("regenerates only dependent work", () => {
    expect(dependentSteps("GENERATE_METADATA")).toEqual(["GENERATE_METADATA", "GENERATE_THUMBNAIL", "CONTENT_QA"]);
    expect(dependentSteps("SELECT_MUSIC")).not.toContain("GENERATE_VOICE");
    expect(dependentSteps("GENERATE_SCRIPT")[0]).toBe("GENERATE_SCRIPT");
    expect(nextStepAfter("YOUTUBE_UPLOAD")).toBe("YOUTUBE_PUBLISH");
    expect(GENERATION_STEPS.at(-1)).toBe("CONTENT_QA");
  });
});
