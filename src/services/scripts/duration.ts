/**
 * Spoken-duration estimation for English narration.
 *
 * duration = words / wpm * 60 + pause allowance for sentence ends and commas.
 * Numbers are expanded to their approximate spoken word count ("1969" -> 4 words),
 * because TTS reads them aloud.
 */
const SENTENCE_PAUSE_SEC = 0.28;
const COMMA_PAUSE_SEC = 0.12;

function spokenWordsForNumber(token: string): number {
  const digits = token.replace(/[^0-9]/g, "");
  if (!digits) return 1;
  if (/^(1[0-9]|20)\d\d$/.test(digits) && digits.length === 4) return 4; // years: "nineteen sixty nine"
  if (digits.length <= 2) return 1;
  if (digits.length === 3) return 3;
  return Math.min(8, Math.ceil(digits.length * 1.3));
}

export function countSpokenWords(text: string): number {
  const tokens = text.split(/\s+/).filter(Boolean);
  let count = 0;
  for (const token of tokens) {
    if (/\d/.test(token)) count += spokenWordsForNumber(token);
    else if (/[\p{L}]/u.test(token)) count += 1;
  }
  return count;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

export function estimateSpeechDurationSec(text: string, wordsPerMinute: number): number {
  const words = countSpokenWords(text);
  const sentences = (text.match(/[.!?…]+(\s|$)/g) ?? []).length;
  const commas = (text.match(/[,;:—–]/g) ?? []).length;
  const seconds = (words / wordsPerMinute) * 60 + sentences * SENTENCE_PAUSE_SEC + commas * COMMA_PAUSE_SEC;
  return Number(seconds.toFixed(2));
}

/** Target word budget for a duration, leaving room for pauses. */
export function targetWordCount(durationSec: number, wordsPerMinute: number): { min: number; target: number; max: number } {
  const effective = durationSec * 0.92; // ~8% of time goes to pauses
  const target = Math.round((effective / 60) * wordsPerMinute);
  return { min: Math.round(target * 0.88), target, max: Math.round(target * 1.08) };
}

export function isWithinDuration(estimatedSec: number, targetSec: number, tolerancePct: number): boolean {
  return Math.abs(estimatedSec - targetSec) <= targetSec * tolerancePct;
}
