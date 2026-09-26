import type { SubtitleStyle } from "@/config/templates";
import type { WordTiming } from "@/services/tts/types";
import { normalizeWord } from "@/services/tts/alignment";

/**
 * Subtitle cue building for Shorts: short phrases (1-3 lines of a few words), broken at
 * punctuation and pauses, never longer than the style's max cue duration.
 */
export interface Cue {
  start: number;
  end: number;
  words: WordTiming[];
  lines: string[][];
}

const PAUSE_BREAK_SEC = 0.45;

/**
 * Transfers transcript timings onto the script's exact wording (correct spelling,
 * punctuation and casing) using a longest-common-subsequence alignment.
 * Unmatched script words get interpolated timings.
 */
export function alignScriptToTranscript(scriptText: string, transcript: WordTiming[]): WordTiming[] {
  const scriptTokens = scriptText.split(/\s+/).filter(Boolean);
  if (transcript.length === 0 || scriptTokens.length === 0) return [];
  const a = scriptTokens.map(normalizeWord);
  const b = transcript.map((w) => normalizeWord(w.text));
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] && a[i] !== "" ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const matches = new Array<number>(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j] && a[i] !== "") {
      matches[i] = j;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }

  const result: WordTiming[] = scriptTokens.map((text) => ({ text, start: -1, end: -1 }));
  matches.forEach((mj, idx) => {
    if (mj >= 0) {
      result[idx]!.start = transcript[mj]!.start;
      result[idx]!.end = transcript[mj]!.end;
    }
  });
  // Interpolate gaps between matched anchors.
  const lastEnd = transcript.at(-1)!.end;
  let k = 0;
  while (k < n) {
    if (result[k]!.start >= 0) {
      k++;
      continue;
    }
    const gapStart = k;
    while (k < n && result[k]!.start < 0) k++;
    const before = gapStart > 0 ? result[gapStart - 1]!.end : transcript[0]!.start;
    const after = k < n ? result[k]!.start : lastEnd;
    const span = Math.max(0.05, after - before);
    const count = k - gapStart;
    for (let g = 0; g < count; g++) {
      result[gapStart + g]!.start = before + (span * g) / count;
      result[gapStart + g]!.end = before + (span * (g + 1)) / count;
    }
  }
  return result;
}

type CueStyle = Pick<SubtitleStyle, "maxWordsPerLine" | "maxLines" | "maxCueDurationSec" | "timingOffsetSec"> &
  Partial<Pick<SubtitleStyle, "fontSize" | "uppercase" | "bold" | "outlineWidth">>;

const FRAME_WIDTH = 1080;
const SIDE_MARGIN = 70;

/** Approximate rendered width of a word in pixels (DejaVu metrics, bold). */
export function estimateTextWidth(text: string, style: CueStyle): number {
  const fontSize = style.fontSize ?? 90;
  const perChar = style.uppercase ? 0.74 : 0.6;
  const boldFactor = style.bold === false ? 0.94 : 1;
  return text.length * fontSize * perChar * boldFactor + (style.outlineWidth ?? 6) * 2;
}

/** Greedy line layout constrained by both word count and available pixel width. */
export function layoutLines(words: string[], style: CueStyle): string[][] {
  const maxWidth = FRAME_WIDTH - SIDE_MARGIN * 2;
  const spaceWidth = (style.fontSize ?? 90) * 0.32;
  const lines: string[][] = [];
  let line: string[] = [];
  let width = 0;
  for (const word of words) {
    const w = estimateTextWidth(word, style);
    const needed = line.length ? width + spaceWidth + w : w;
    if (line.length && (needed > maxWidth || line.length >= style.maxWordsPerLine)) {
      lines.push(line);
      line = [word];
      width = w;
    } else {
      line.push(word);
      width = needed;
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

export function buildCues(words: WordTiming[], style: CueStyle): Cue[] {
  const cues: Cue[] = [];
  let current: WordTiming[] = [];

  const flush = () => {
    if (current.length === 0) return;
    cues.push({
      start: Math.max(0, current[0]!.start + style.timingOffsetSec),
      end: current.at(-1)!.end + style.timingOffsetSec,
      words: current.map((w) => ({ ...w, start: w.start + style.timingOffsetSec, end: w.end + style.timingOffsetSec })),
      lines: layoutLines(current.map((w) => w.text), style),
    });
    current = [];
  };

  words.forEach((word, index) => {
    // Start a new cue if this word would overflow the allowed number of lines.
    if (current.length && layoutLines([...current, word].map((w) => w.text), style).length > style.maxLines) flush();
    const next = words[index + 1];
    current.push(word);
    const duration = word.end - current[0]!.start;
    const punctuation = /[.!?,;:—–]$/.test(word.text);
    const pause = next ? next.start - word.end > PAUSE_BREAK_SEC : true;
    if (punctuation || pause || duration >= style.maxCueDurationSec) flush();
  });
  flush();

  // Keep each cue on screen until the next one starts (no flicker), capped by a small hold.
  return cues.map((cue, i) => {
    const next = cues[i + 1];
    const hold = next ? Math.min(next.start, cue.end + 0.35) : cue.end + 0.5;
    return { ...cue, end: Math.max(cue.end, hold) };
  });
}

export function cuesToText(cues: Cue[]): string {
  return cues.map((c) => c.lines.map((l) => l.join(" ")).join(" ")).join(" ");
}

function srtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

/** SRT export (for download / closed captions). */
export function cuesToSrt(cues: Cue[]): string {
  return cues
    .map((cue, i) => `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.lines.map((l) => l.join(" ")).join("\n")}\n`)
    .join("\n");
}
