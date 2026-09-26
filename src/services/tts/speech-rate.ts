import { db } from "@/lib/db";
import { countSpokenWords } from "@/services/scripts/duration";

/**
 * Speaking-rate calibration.
 *
 * Voices speak at different speeds (Kokoro ~210 wpm, ElevenLabs narrators ~160 wpm).
 * To make scripts fit the target duration, the words-per-minute used for the word
 * budget is learned from this voice's previous voiceovers (median of recent samples),
 * falling back to an engine default until samples exist.
 */
const ENGINE_DEFAULT_WPM: Record<string, number> = { kokoro: 210 };
const SENTENCE_PAUSE_SEC = 0.28;
const COMMA_PAUSE_SEC = 0.12;

/** The words-per-minute that makes `estimateSpeechDurationSec(text, wpm)` equal `durationSec`. */
export function impliedWordsPerMinute(text: string, durationSec: number): number | null {
  const words = countSpokenWords(text);
  const sentences = (text.match(/[.!?…]+(\s|$)/g) ?? []).length;
  const commas = (text.match(/[,;:—–]/g) ?? []).length;
  const speaking = durationSec - 0.2 - sentences * SENTENCE_PAUSE_SEC - commas * COMMA_PAUSE_SEC;
  if (words < 15 || speaking <= 2) return null;
  return (words / speaking) * 60;
}

export async function calibratedWordsPerMinute(opts: { provider: string; voiceId: string; speed: number; fallbackWpm: number }): Promise<number> {
  const samples = await db.voiceover.findMany({
    where: { provider: opts.provider, voiceId: opts.voiceId },
    orderBy: { createdAt: "desc" },
    take: 15,
    include: { scriptVersion: { select: { fullText: true } } },
  });
  const rates = samples
    .map((s) => {
      const speed = (s.settings as { speed?: number } | null)?.speed ?? 1;
      const wpm = impliedWordsPerMinute(s.scriptVersion.fullText, s.durationSec);
      return wpm ? wpm / speed : null; // normalise to speed 1.0
    })
    .filter((r): r is number => r !== null)
    .sort((a, b) => a - b);
  const base = rates.length ? rates[Math.floor(rates.length / 2)]! : ENGINE_DEFAULT_WPM[opts.provider] ?? opts.fallbackWpm;
  return Math.round(Math.min(260, Math.max(110, base * opts.speed)));
}
