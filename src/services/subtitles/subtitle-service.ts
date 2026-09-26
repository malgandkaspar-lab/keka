import type { Prisma, Subtitle } from "@/generated/prisma/client";
import type { SubtitleStyle } from "@/config/templates";
import { STT_COST_PER_MINUTE } from "@/config/pricing";
import { db } from "@/lib/db";
import { LanguageValidationError, QualityCheckError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { analyzeLanguage } from "@/services/language/language-service";
import { storeAsset } from "@/services/media/media-service";
import { getStorage } from "@/services/storage";
import { wordErrorRate } from "@/services/tts/alignment";
import type { SpeechToTextProvider, TranscriptionResult, WordTiming } from "@/services/tts/types";
import { renderAss } from "./ass";
import { alignScriptToTranscript, buildCues, cuesToText, type Cue } from "./cues";

/**
 * SubtitleService
 *
 * Purpose: produce accurate English subtitles from the *final voiceover audio*.
 * Provider: SpeechToTextProvider (language forced to English, word timestamps).
 * Process: transcribe -> verify transcript is English and matches the script ->
 * transfer timings onto the script's exact wording -> build short Shorts-style cues
 * -> render an ASS file in the selected style and store it.
 * Fallback: when transcription is unavailable, the TTS provider's character
 * timestamps are used (still derived from the final audio).
 * Errors: LanguageValidationError (voiceover/subtitles not English),
 * QualityCheckError (voiceover does not match the script).
 */
const log = createLogger({ module: "subtitles" });
const MAX_WER = 0.35;

export interface SubtitleGenerationInput {
  videoId: string;
  userId: string;
  scriptText: string;
  voiceoverKey: string;
  voiceoverDurationSec: number;
  ttsWords: WordTiming[];
  style: SubtitleStyle;
  stt: SpeechToTextProvider | null;
  signal?: AbortSignal;
}

export interface SubtitleGenerationResult {
  subtitle: Subtitle;
  costUsd: number;
  provider: string;
  wer: number | null;
}

export function validateTranscript(transcript: TranscriptionResult, scriptText: string): { wer: number } {
  if (transcript.language && !["en", "eng", "english"].includes(transcript.language.toLowerCase())) {
    throw new LanguageValidationError("voiceover", [`speech-to-text detected language "${transcript.language}"`]);
  }
  const language = analyzeLanguage(transcript.text, "subtitles");
  if (!language.isEnglish) throw new LanguageValidationError("voiceover", language.reasons);
  const wer = wordErrorRate(scriptText, transcript.text);
  if (wer > MAX_WER) {
    throw new QualityCheckError(`Voiceover does not match the script (word error rate ${(wer * 100).toFixed(0)}%)`, { wer }, true);
  }
  return { wer };
}

export async function transcribeVoiceover(input: SubtitleGenerationInput): Promise<{
  words: WordTiming[];
  transcript: string;
  detectedLanguage: string | null;
  provider: string;
  costUsd: number;
  wer: number | null;
}> {
  if (input.stt) {
    try {
      const audio = await getStorage().download(input.voiceoverKey);
      const transcript = await input.stt.transcribe(audio, "voiceover.mp3", input.signal);
      const { wer } = validateTranscript(transcript, input.scriptText);
      const aligned = alignScriptToTranscript(input.scriptText, transcript.words);
      return {
        words: aligned.length ? aligned : transcript.words,
        transcript: transcript.text,
        detectedLanguage: transcript.language ?? "en",
        provider: input.stt.name,
        costUsd: (input.voiceoverDurationSec / 60) * (input.stt.costPerMinute ?? STT_COST_PER_MINUTE),
        wer,
      };
    } catch (error) {
      if (error instanceof LanguageValidationError || error instanceof QualityCheckError) throw error;
      if (input.ttsWords.length === 0) throw error;
      log.warn({ videoId: input.videoId, err: (error as Error).message }, "speech-to-text failed, using TTS timestamps");
    }
  }
  if (input.ttsWords.length === 0) {
    throw new QualityCheckError("No word timings available: configure speech-to-text or a TTS model with timestamps");
  }
  const aligned = alignScriptToTranscript(input.scriptText, input.ttsWords);
  return {
    words: aligned.length ? aligned : input.ttsWords,
    transcript: input.ttsWords.map((w) => w.text).join(" "),
    detectedLanguage: "en",
    provider: "tts-alignment",
    costUsd: 0,
    wer: null,
  };
}

export async function generateSubtitles(input: SubtitleGenerationInput): Promise<SubtitleGenerationResult> {
  const timing = await transcribeVoiceover(input);
  return saveSubtitleTrack({ ...input, ...timing });
}

/** Rebuilds cues + ASS from word timings (used for restyling without re-transcribing). */
export async function saveSubtitleTrack(input: {
  videoId: string;
  userId: string;
  style: SubtitleStyle;
  words: WordTiming[];
  transcript: string;
  detectedLanguage: string | null;
  provider: string;
  costUsd?: number;
  wer?: number | null;
}): Promise<SubtitleGenerationResult> {
  const cues: Cue[] = buildCues(input.words, input.style);
  const text = cuesToText(cues);
  const language = analyzeLanguage(text, "subtitles");
  if (!language.isEnglish) throw new LanguageValidationError("subtitles", language.reasons);

  const ass = renderAss(cues, input.style);
  const asset = await storeAsset({
    userId: input.userId,
    kind: "SUBTITLE",
    key: `videos/${input.videoId}/subtitles/${Date.now()}.ass`,
    mimeType: "text/x-ssa",
    source: "GENERATED",
    data: Buffer.from(ass, "utf8"),
    metadata: { style: input.style.key, cues: cues.length },
  });

  const subtitle = await db.$transaction(async (tx) => {
    await tx.subtitle.updateMany({ where: { videoId: input.videoId, isCurrent: true }, data: { isCurrent: false } });
    return tx.subtitle.create({
      data: {
        videoId: input.videoId,
        language: "en",
        provider: input.provider,
        styleKey: input.style.key,
        transcript: input.transcript,
        detectedLanguage: input.detectedLanguage,
        words: input.words as unknown as Prisma.InputJsonValue,
        cues: cues as unknown as Prisma.InputJsonValue,
        assetId: asset.id,
      },
    });
  });
  return { subtitle, costUsd: input.costUsd ?? 0, provider: input.provider, wer: input.wer ?? null };
}

export async function currentSubtitle(videoId: string) {
  return db.subtitle.findFirst({ where: { videoId, isCurrent: true }, include: { asset: true }, orderBy: { createdAt: "desc" } });
}
