import { z } from "zod";
import type { VideoStyle } from "@/config/templates";
import type { AIProvider, AIUsage } from "@/services/ai/types";
import { analyzeList } from "@/services/language/language-service";
import { ENGLISH_ONLY_PROMPT } from "@/services/policy/content-policy";
import type { WordTiming } from "@/services/tts/types";
import { estimateWordTimings } from "@/services/tts/alignment";

/**
 * Visual planning.
 *
 * 1. segmentNarration(): split the spoken narration into shots using the real word
 *    timings of the voiceover, respecting the template's shot-length rules and
 *    preferring punctuation boundaries. This guarantees the scenes cover the whole
 *    narration, in order, and are synchronised with the voice.
 * 2. planVisuals(): the AI writes a visual description, stock-footage keywords,
 *    broader fallback keywords and a transition for every shot, plus a music mood.
 */
export interface NarrationSegment {
  index: number;
  text: string;
  start: number;
  end: number;
}

const TAIL_SEC = 0.6;

export function segmentNarration(
  words: WordTiming[],
  audioDurationSec: number,
  style: Pick<VideoStyle, "targetShotSec" | "minShotSec" | "maxShotSec">,
): NarrationSegment[] {
  if (words.length === 0) return [];
  const totalEnd = audioDurationSec + TAIL_SEC;
  const groups: WordTiming[][] = [];
  let current: WordTiming[] = [];
  let groupStart = 0;

  words.forEach((word, i) => {
    current.push(word);
    const elapsed = word.end - groupStart;
    const next = words[i + 1];
    const boundary = /[.!?;:,—–]$/.test(word.text);
    const sentenceEnd = /[.!?]$/.test(word.text);
    const shouldBreak =
      next !== undefined &&
      ((elapsed >= style.targetShotSec && boundary) ||
        (elapsed >= style.minShotSec && sentenceEnd && elapsed >= style.targetShotSec * 0.75) ||
        elapsed >= style.maxShotSec);
    if (shouldBreak) {
      groups.push(current);
      current = [];
      groupStart = next.start;
    }
  });
  if (current.length) groups.push(current);

  // Merge a too-short final group into the previous one.
  if (groups.length > 1) {
    const last = groups.at(-1)!;
    const lastDuration = totalEnd - last[0]!.start;
    if (lastDuration < style.minShotSec) {
      groups.splice(-2, 2, [...groups.at(-2)!, ...last]);
    }
  }

  return groups.map((group, index) => {
    const start = index === 0 ? 0 : group[0]!.start;
    const nextGroup = groups[index + 1];
    const end = nextGroup ? nextGroup[0]!.start : totalEnd;
    return { index, text: group.map((w) => w.text).join(" "), start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) };
  });
}

export const TRANSITIONS = ["cut", "fade", "slideleft", "slideup", "smoothleft", "circleopen", "dissolve"] as const;
export const MUSIC_MOODS = ["mysterious", "cinematic", "energetic", "inspiring", "technological", "documentary", "calm", "playful", "dramatic"] as const;

export const visualPlanSchema = z.object({
  musicMood: z.enum(MUSIC_MOODS),
  scenes: z.array(
    z.object({
      index: z.number().int(),
      visualDescription: z.string(),
      keywords: z.array(z.string()).describe("2-4 concrete English stock footage search queries, most specific first"),
      fallbackKeywords: z.array(z.string()).describe("2-3 broader English search queries"),
      transition: z.enum(TRANSITIONS),
    }),
  ),
});
export type VisualPlan = z.infer<typeof visualPlanSchema>;

export interface PlannedScene extends NarrationSegment {
  visualDescription: string;
  keywords: string[];
  fallbackKeywords: string[];
  transition: string;
}

const SYSTEM = `You are a video editor planning B-roll for a vertical YouTube Short.
For every narration segment choose visuals that literally illustrate what is being said and that
exist as generic stock footage (Pexels). Search queries must be short (1-4 words), concrete and
visual (objects, places, actions) - never abstract ideas, brand names, celebrities or text.
Avoid choosing the same visual for consecutive shots.
${ENGLISH_ONLY_PROMPT}`;

export async function planVisuals(opts: {
  ai: AIProvider;
  topic: string;
  segments: NarrationSegment[];
  defaultTransition: string;
  preferredMoods: string[];
  signal?: AbortSignal;
}): Promise<{ scenes: PlannedScene[]; musicMood: string; usage: AIUsage }> {
  const result = await opts.ai.generateStructured({
    purpose: "visuals.plan",
    system: SYSTEM,
    prompt: [
      `Topic: ${opts.topic}`,
      `Template default transition: ${opts.defaultTransition}. Preferred music moods: ${opts.preferredMoods.join(", ") || "any"}.`,
      "Narration segments (index: [start-end seconds] text):",
      ...opts.segments.map((s) => `${s.index}: [${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`),
      "Return exactly one scene per segment index, in order.",
    ].join("\n"),
    schema: visualPlanSchema,
    effort: "low",
    signal: opts.signal,
  });

  const byIndex = new Map(result.data.scenes.map((s) => [s.index, s]));
  const scenes = opts.segments.map((segment) => {
    const plan = byIndex.get(segment.index);
    const keywords = cleanQueries(plan?.keywords ?? []);
    const fallbackKeywords = cleanQueries(plan?.fallbackKeywords ?? []);
    return {
      ...segment,
      visualDescription: plan?.visualDescription ?? segment.text,
      keywords: keywords.length ? keywords : deriveKeywords(segment.text),
      fallbackKeywords: fallbackKeywords.length ? fallbackKeywords : [opts.topic.split(/\s+/).slice(0, 3).join(" ")],
      transition: plan?.transition ?? opts.defaultTransition,
    };
  });
  return { scenes, musicMood: result.data.musicMood, usage: result.usage };
}

function cleanQueries(queries: string[]): string[] {
  const cleaned = queries
    .map((q) => q.replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase())
    .filter((q) => q.length >= 2 && q.split(" ").length <= 5);
  const unique = [...new Set(cleaned)];
  return analyzeList(unique, "tags").isEnglish ? unique : unique.filter((q) => analyzeList([q], "tags").isEnglish);
}

const KEYWORD_STOP = new Set("the a an and or but of to in on at for with from this that these those is are was were be it its you your they them their what why how when who which just".split(" "));

/** Fallback keywords straight from the narration when the AI omitted them. */
export function deriveKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !KEYWORD_STOP.has(w));
  return [...new Set(words)].slice(0, 3);
}

/** When the voiceover has no timestamps, estimate them from the script text. */
export function wordsOrEstimate(words: WordTiming[], text: string, durationSec: number): WordTiming[] {
  return words.length > 0 ? words : estimateWordTimings(text, durationSec);
}
