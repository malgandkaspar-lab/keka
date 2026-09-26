import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Prisma, ScriptVersion, VoicePreset, Voiceover } from "@/generated/prisma/client";
import { TTS_COST_PER_1K_CHARS } from "@/config/pricing";
import { db } from "@/lib/db";
import { stableHash } from "@/lib/crypto";
import { LanguageValidationError, MediaProcessingError, NotFoundError } from "@/lib/errors";
import { withWorkDir } from "@/lib/workdir";
import { analyzeLanguage } from "@/services/language/language-service";
import { storeAsset } from "@/services/media/media-service";
import { mediaInfo } from "@/services/video/ffmpeg";
import { charactersToWords } from "./alignment";
import { alignScriptToTranscript } from "@/services/subtitles/cues";
import { createLogger } from "@/lib/logger";
import type { SpeechToTextProvider, TTSProvider, VoiceSettings, WordTiming } from "./types";

/**
 * VoiceoverService
 *
 * Purpose: turn a validated English script version into a stored voiceover.
 * Inputs: video id, script version, English voice preset, voice settings.
 * Outputs: Voiceover row (voice id, duration, audio asset, word timings, metadata).
 *
 * Guarantees:
 *  - English only: the script text is re-validated before synthesis (never translated).
 *  - Cost control: identical text+voice+settings reuse the cached audio.
 *  - Duration control: if narration overruns the target by >15%, it is re-synthesised
 *    once at a faster (still natural) speed within the provider's supported range.
 */
export interface VoiceoverOptions {
  videoId: string;
  userId: string;
  scriptVersion: ScriptVersion;
  voice: VoicePreset;
  modelId: string;
  settings: VoiceSettings;
  targetDurationSec: number;
  provider: TTSProvider;
  /** Used to obtain word timings when the TTS engine does not return them. */
  stt?: SpeechToTextProvider | null;
  signal?: AbortSignal;
}

export interface VoiceoverResult {
  voiceover: Voiceover;
  costUsd: number;
  reused: boolean;
  words: WordTiming[];
}

const MAX_SPEED = 1.15;
const MIN_SPEED = 0.88;
const log = createLogger({ module: "voiceover" });

export function voiceCacheKey(text: string, voiceId: string, modelId: string, settings: VoiceSettings): string {
  return stableHash({ text, voiceId, modelId, settings, v: 1 });
}

/**
 * Resolves the English voice to use for a TTS provider. A preset belonging to another
 * provider (e.g. an ElevenLabs voice while the free Kokoro engine is selected) falls
 * back to the provider's first voice with a similar gender.
 */
export async function resolveVoice(voicePresetId: string | null | undefined, provider?: string): Promise<VoicePreset> {
  const requested = voicePresetId ? await db.voicePreset.findUnique({ where: { id: voicePresetId } }) : null;
  let voice = requested && (!provider || requested.provider === provider) ? requested : null;
  if (!voice) {
    const candidates = await db.voicePreset.findMany({
      where: { enabled: true, language: "en", ...(provider ? { provider } : {}) },
      orderBy: { createdAt: "asc" },
    });
    voice = candidates.find((c) => requested?.gender && c.gender === requested.gender) ?? candidates[0] ?? null;
    // A provider without a voice catalogue (e.g. a custom engine) accepts any English preset.
    if (!voice && candidates.length === 0) {
      voice = requested ?? (await db.voicePreset.findFirst({ where: { enabled: true, language: "en" }, orderBy: { createdAt: "asc" } }));
    }
  }
  if (!voice) throw new NotFoundError(`English voice for ${provider ?? "the TTS provider"}`, voicePresetId ?? "default");
  if (voice.language !== "en") throw new LanguageValidationError("voice", [`voice "${voice.name}" is not an English voice`]);
  return voice;
}

async function synthesizeAndStore(opts: VoiceoverOptions, settings: VoiceSettings, workDir: string) {
  const text = opts.scriptVersion.fullText;
  const cacheKey = voiceCacheKey(text, opts.voice.voiceId, opts.modelId, settings);
  const existing = await db.voiceover.findFirst({ where: { cacheKey }, orderBy: { createdAt: "desc" } });
  if (existing) return { cacheKey, existing, costUsd: 0 };

  const result = await opts.provider.synthesize({
    text,
    voiceId: opts.voice.voiceId,
    modelId: opts.modelId,
    settings,
    signal: opts.signal,
  });
  const localPath = path.join(workDir, `${cacheKey}.${result.extension}`);
  await writeFile(localPath, result.audio);
  const info = await mediaInfo(localPath);
  if (!info.hasAudio || info.durationSec < 1) throw new MediaProcessingError("Voiceover audio is empty or unreadable");
  const asset = await storeAsset({
    userId: opts.userId,
    kind: "AUDIO_VOICE",
    key: `voice/${cacheKey}.${result.extension}`,
    mimeType: result.mimeType,
    source: opts.provider.name === "elevenlabs" ? "ELEVENLABS" : "GENERATED",
    filePath: localPath,
    probe: true,
    author: opts.provider.name,
    license: "Generated with the account's TTS provider plan",
    metadata: { voiceId: opts.voice.voiceId, modelId: opts.modelId },
  });
  let words = result.alignment ? charactersToWords(result.alignment) : [];
  if (words.length === 0 && opts.stt) {
    // No engine timestamps: recognise the generated audio to get exact word timings.
    try {
      const transcript = await opts.stt.transcribe(result.audio, `voice.${result.extension}`, opts.signal);
      words = alignScriptToTranscript(text, transcript.words);
    } catch (error) {
      log.warn({ err: (error as Error).message }, "could not derive word timings from the voiceover");
    }
  }
  return {
    cacheKey,
    existing: null,
    costUsd: (result.characters / 1000) * (opts.provider.costPer1kChars ?? TTS_COST_PER_1K_CHARS),
    created: { asset, durationSec: info.durationSec, words, alignment: result.alignment },
  };
}

export async function generateVoiceover(opts: VoiceoverOptions): Promise<VoiceoverResult> {
  const language = analyzeLanguage(opts.scriptVersion.fullText, "script");
  if (!language.isEnglish) throw new LanguageValidationError("script", language.reasons);

  return withWorkDir("voice", async (workDir) => {
    let settings: VoiceSettings = { ...opts.settings };
    let totalCost = 0;
    let attempt = await synthesizeAndStore(opts, settings, workDir);
    totalCost += attempt.costUsd;

    const durationOf = (a: typeof attempt) => a.existing?.durationSec ?? a.created?.durationSec ?? 0;
    const currentSpeed = settings.speed ?? 1;
    const duration = durationOf(attempt);
    if (duration > opts.targetDurationSec * 1.15 && currentSpeed < MAX_SPEED) {
      const speed = Number(Math.min(MAX_SPEED, currentSpeed * (duration / opts.targetDurationSec)).toFixed(2));
      settings = { ...settings, speed };
      attempt = await synthesizeAndStore(opts, settings, workDir);
      totalCost += attempt.costUsd;
    } else if (duration < opts.targetDurationSec * 0.82 && currentSpeed > MIN_SPEED) {
      // Narration came out much shorter than planned: slow down slightly (stays natural).
      const speed = Number(Math.max(MIN_SPEED, currentSpeed * (duration / (opts.targetDurationSec * 0.92))).toFixed(2));
      if (speed < currentSpeed - 0.02) {
        settings = { ...settings, speed };
        attempt = await synthesizeAndStore(opts, settings, workDir);
        totalCost += attempt.costUsd;
      }
    }

    await db.voiceover.updateMany({ where: { videoId: opts.videoId, isCurrent: true }, data: { isCurrent: false } });

    if (attempt.existing) {
      const source = attempt.existing;
      const voiceover = await db.voiceover.create({
        data: {
          videoId: opts.videoId,
          scriptVersionId: opts.scriptVersion.id,
          assetId: source.assetId,
          provider: source.provider,
          voiceId: source.voiceId,
          voiceName: opts.voice.name,
          modelId: source.modelId,
          settings: settings as Prisma.InputJsonValue,
          cacheKey: attempt.cacheKey,
          durationSec: source.durationSec,
          alignment: source.alignment ?? undefined,
          metadata: { ...(source.metadata as Record<string, unknown>), reusedFrom: source.id } as Prisma.InputJsonValue,
        },
      });
      const words = ((source.metadata as { words?: WordTiming[] }).words ?? []) as WordTiming[];
      return { voiceover, costUsd: totalCost, reused: totalCost === 0, words };
    }

    const created = attempt.created!;
    const voiceover = await db.voiceover.create({
      data: {
        videoId: opts.videoId,
        scriptVersionId: opts.scriptVersion.id,
        assetId: created.asset.id,
        provider: opts.provider.name,
        voiceId: opts.voice.voiceId,
        voiceName: opts.voice.name,
        modelId: opts.modelId,
        settings: settings as Prisma.InputJsonValue,
        cacheKey: attempt.cacheKey,
        durationSec: created.durationSec,
        alignment: created.alignment ? (created.alignment as unknown as Prisma.InputJsonValue) : undefined,
        metadata: { words: created.words, characters: opts.scriptVersion.fullText.length } as unknown as Prisma.InputJsonValue,
      },
    });
    return { voiceover, costUsd: totalCost, reused: false, words: created.words };
  });
}

export async function currentVoiceover(videoId: string) {
  const voiceover = await db.voiceover.findFirst({
    where: { videoId, isCurrent: true },
    include: { asset: true },
    orderBy: { createdAt: "desc" },
  });
  if (!voiceover) throw new NotFoundError("Voiceover for video", videoId);
  return voiceover;
}

export function voiceoverWords(voiceover: Voiceover): WordTiming[] {
  return ((voiceover.metadata as { words?: WordTiming[] } | null)?.words ?? []) as WordTiming[];
}
