import type { CharacterAlignment, WordTiming } from "./types";

/**
 * Timing utilities: convert provider character alignments to word timings, and map
 * arbitrary text segments (scene narration) onto the spoken timeline.
 */
export function charactersToWords(alignment: CharacterAlignment): WordTiming[] {
  const words: WordTiming[] = [];
  let current = "";
  let start = 0;
  let end = 0;
  alignment.characters.forEach((char, i) => {
    const charStart = alignment.starts[i] ?? end;
    const charEnd = alignment.ends[i] ?? charStart;
    if (/\s/.test(char)) {
      if (current) words.push({ text: current, start, end });
      current = "";
      return;
    }
    if (!current) start = charStart;
    current += char;
    end = charEnd;
  });
  if (current) words.push({ text: current, start, end });
  return words;
}

export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, "");
}

/**
 * Proportional fallback when no timestamps exist: distribute words over the audio
 * duration weighted by character length.
 */
export function estimateWordTimings(text: string, durationSec: number): WordTiming[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const weights = tokens.map((t) => Math.max(1, t.length) + (/[.!?]$/.test(t) ? 3 : /[,;:]$/.test(t) ? 1.5 : 0));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let cursor = 0;
  return tokens.map((token, i) => {
    const span = (weights[i]! / total) * durationSec;
    const timing = { text: token, start: cursor, end: cursor + span * 0.92 };
    cursor += span;
    return timing;
  });
}

/**
 * Splits `words` into consecutive groups matching the word counts of `segments`
 * (scene narrations). Tolerates small differences between the script and the
 * transcription by matching normalised words greedily.
 */
export function mapSegmentsToTimeline(
  segments: string[],
  words: WordTiming[],
  totalDurationSec: number,
): { start: number; end: number }[] {
  if (segments.length === 0) return [];
  if (words.length === 0) {
    const counts = segments.map((s) => s.split(/\s+/).filter(Boolean).length || 1);
    const total = counts.reduce((a, b) => a + b, 0);
    let cursor = 0;
    return counts.map((c) => {
      const span = (c / total) * totalDurationSec;
      const range = { start: cursor, end: cursor + span };
      cursor += span;
      return range;
    });
  }
  const normalizedWords = words.map((w) => normalizeWord(w.text));
  const ranges: { start: number; end: number }[] = [];
  let index = 0;
  segments.forEach((segment, segIndex) => {
    const segWords = segment.split(/\s+/).map(normalizeWord).filter(Boolean);
    const startIndex = Math.min(index, words.length - 1);
    let endIndex = Math.min(words.length - 1, startIndex + Math.max(0, segWords.length - 1));
    // Snap to the last word of the segment if it appears nearby (handles STT drift).
    const lastWord = segWords.at(-1);
    if (lastWord) {
      for (let delta = 0; delta <= 3; delta++) {
        for (const candidate of [endIndex + delta, endIndex - delta]) {
          if (candidate >= startIndex && candidate < words.length && normalizedWords[candidate] === lastWord) {
            endIndex = candidate;
            delta = 99;
            break;
          }
        }
      }
    }
    if (segIndex === segments.length - 1) endIndex = words.length - 1;
    ranges.push({ start: words[startIndex]!.start, end: words[endIndex]!.end });
    index = endIndex + 1;
  });
  // Make ranges contiguous: each scene lasts until the next begins; first starts at 0.
  return ranges.map((range, i) => ({
    start: i === 0 ? 0 : range.start,
    end: i === ranges.length - 1 ? Math.max(range.end, totalDurationSec) : ranges[i + 1]!.start,
  }));
}

/** Word error rate between reference text and transcription (0 = identical). */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = reference.split(/\s+/).map(normalizeWord).filter(Boolean);
  const hyp = hypothesis.split(/\s+/).map(normalizeWord).filter(Boolean);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  const prev = new Array<number>(hyp.length + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= hyp.length; j++) {
      const temp = prev[j]!;
      prev[j] = ref[i - 1] === hyp[j - 1] ? diag : 1 + Math.min(diag, prev[j]!, prev[j - 1]!);
      diag = temp;
    }
  }
  return prev[hyp.length]! / ref.length;
}
