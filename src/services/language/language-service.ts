import { createRequire } from "node:module";
import { francAll } from "franc";
import { LanguageValidationError } from "@/lib/errors";

/**
 * LanguageService - programmatic English-only validation.
 *
 * Purpose: guarantee that every piece of generated content (topic, research summary,
 * script, title, description, hashtags, subtitles, thumbnail text) is English,
 * independent of what the AI prompt asked for.
 *
 * Signals combined (no single signal is trusted alone):
 *  1. Script check: letters outside the Latin script (Cyrillic, Greek, CJK, Arabic, ...).
 *  2. Diacritics: Latin letters with diacritics common in other languages (õ, ä, š, ñ...).
 *  3. Dictionary coverage: share of words found in a 275k-word English dictionary
 *     (with light suffix stemming), which works even for very short text.
 *  4. Statistical detection (franc trigram model) for longer passages.
 *  5. Sentence-level scan, so a single non-English sentence inside an otherwise
 *     English script is still caught.
 *
 * Output: LanguageAnalysis { isEnglish, confidence, reasons, metrics }.
 * Errors: `assertEnglish` throws LanguageValidationError (retryable -> regenerate).
 */
export type ContentKind =
  | "topic"
  | "research"
  | "script"
  | "title"
  | "description"
  | "hashtags"
  | "tags"
  | "subtitles"
  | "thumbnail"
  | "text";

export interface LanguageMetrics {
  letters: number;
  nonLatinRatio: number;
  diacriticRatio: number;
  words: number;
  englishWordRatio: number;
  detectedLanguage: string | null;
  detectedScore: number | null;
  englishScore: number | null;
  nonEnglishSentences: string[];
}

export interface LanguageAnalysis {
  isEnglish: boolean;
  confidence: number;
  reasons: string[];
  metrics: LanguageMetrics;
}

const require = createRequire(import.meta.url);
let dictionary: Set<string> | undefined;

function englishDictionary(): Set<string> {
  if (!dictionary) {
    const words = require("an-array-of-english-words") as string[];
    dictionary = new Set(words);
    // Common modern / short-form vocabulary missing from classic word lists.
    for (const extra of EXTRA_ENGLISH_WORDS) dictionary.add(extra);
  }
  return dictionary;
}

const EXTRA_ENGLISH_WORDS = [
  "youtube", "shorts", "ai", "online", "internet", "website", "smartphone", "app", "apps", "email", "nasa",
  "esa", "iss", "dna", "rna", "wifi", "gps", "usb", "tv", "ok", "okay", "vs", "etc", "eg", "ie", "covid",
  "subscribe", "subscribed", "livestream", "podcast", "chatbot", "chatbots", "blockchain", "crypto", "bitcoin",
  "emoji", "selfie", "hashtag", "hashtags", "google", "apple", "microsoft", "amazon", "tesla", "spacex",
  "facebook", "instagram", "tiktok", "iphone", "android", "earth", "mars", "jupiter", "saturn", "venus",
  "mercury", "neptune", "uranus", "pluto", "einstein", "newton", "darwin", "tesla's", "don't", "can't",
  "won't", "isn't", "aren't", "didn't", "doesn't", "wasn't", "weren't", "it's", "that's", "there's",
  "you're", "we're", "they're", "i'm", "you'll", "we'll", "i've", "you've", "what's", "here's", "let's",
];

const LATIN_LETTER = /\p{Script=Latin}/u;
const ANY_LETTER = /\p{L}/u;
const DIACRITIC_LETTERS = /[àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿāăąćčďđēėęěğīįıķłńňőœřśşšťūůűųźżžșț]/iu;

// franc language codes considered "English-like" noise at low confidence.
const FRANC_WHITELIST = [
  "eng", "est", "lav", "lit", "rus", "ukr", "deu", "fin", "spa", "fra", "ita", "por", "nld", "pol",
  "swe", "dan", "nob", "ces", "slk", "hun", "ron", "tur", "cat", "hrv", "srp", "slv", "bul", "ell",
  "vie", "ind", "tgl", "swh", "afr",
];

function stripNoise(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[@#]/g, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[0-9]+([.,:][0-9]+)*(%|st|nd|rd|th|s|km|m|kg|g|cm|mm|mph|kph|°c|°f)?/giu, " ");
}

/** Splits CamelCase hashtags ("#SpaceFacts" -> "Space Facts"). */
export function splitCompoundWords(text: string): string {
  return text.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

export function tokenize(text: string): string[] {
  return (
    stripNoise(splitCompoundWords(text))
      .toLowerCase()
      .replace(/[’‘`]/g, "'")
      .match(/[\p{L}']+/gu)
      ?.map((w) => w.replace(/^'+|'+$/g, ""))
      .filter((w) => w.length > 0) ?? []
  );
}

function stemCandidates(word: string): string[] {
  const candidates = [word];
  if (word.endsWith("'s")) candidates.push(word.slice(0, -2));
  if (word.endsWith("s")) candidates.push(word.slice(0, -1));
  if (word.endsWith("es")) candidates.push(word.slice(0, -2));
  if (word.endsWith("ies")) candidates.push(`${word.slice(0, -3)}y`);
  if (word.endsWith("ed")) candidates.push(word.slice(0, -2), word.slice(0, -1));
  if (word.endsWith("ing")) candidates.push(word.slice(0, -3), `${word.slice(0, -3)}e`);
  if (word.endsWith("ly")) candidates.push(word.slice(0, -2));
  if (word.endsWith("er")) candidates.push(word.slice(0, -2), word.slice(0, -1));
  if (word.endsWith("est")) candidates.push(word.slice(0, -3), word.slice(0, -2));
  return candidates;
}

export function isEnglishWord(word: string): boolean {
  const dict = englishDictionary();
  return stemCandidates(word.toLowerCase()).some((c) => c.length > 0 && dict.has(c));
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface Thresholds {
  minEnglishWordRatio: number;
  francMinLength: number;
}

const THRESHOLDS: Record<ContentKind, Thresholds> = {
  topic: { minEnglishWordRatio: 0.6, francMinLength: 60 },
  research: { minEnglishWordRatio: 0.7, francMinLength: 80 },
  script: { minEnglishWordRatio: 0.75, francMinLength: 80 },
  title: { minEnglishWordRatio: 0.6, francMinLength: 60 },
  description: { minEnglishWordRatio: 0.7, francMinLength: 80 },
  hashtags: { minEnglishWordRatio: 0.6, francMinLength: 1_000_000 },
  tags: { minEnglishWordRatio: 0.6, francMinLength: 1_000_000 },
  subtitles: { minEnglishWordRatio: 0.75, francMinLength: 80 },
  thumbnail: { minEnglishWordRatio: 0.6, francMinLength: 1_000_000 },
  text: { minEnglishWordRatio: 0.7, francMinLength: 80 },
};

function letterStats(text: string): { letters: number; nonLatin: number; diacritics: number } {
  let letters = 0;
  let nonLatin = 0;
  let diacritics = 0;
  for (const ch of text) {
    if (!ANY_LETTER.test(ch)) continue;
    letters++;
    if (!LATIN_LETTER.test(ch)) nonLatin++;
    else if (DIACRITIC_LETTERS.test(ch)) diacritics++;
  }
  return { letters, nonLatin, diacritics };
}

function englishWordRatio(words: string[]): number {
  if (words.length === 0) return 1;
  // Very short tokens ("a", "i") are uninformative - count them but weigh the rest.
  const informative = words.filter((w) => w.length >= 2);
  if (informative.length === 0) return 1;
  const hits = informative.filter(isEnglishWord).length;
  return hits / informative.length;
}

/**
 * Removes likely proper nouns (capitalised words that are not sentence-initial) from
 * running prose, so names like "Procopio" or "Tranquility Base" do not count against
 * English coverage. Title-cased text (most words capitalised) is left untouched, which
 * keeps short non-English titles detectable.
 */
function withoutProperNouns(text: string): string[] {
  const kept: string[] = [];
  for (const sentence of splitSentences(text)) {
    const raw = splitCompoundWords(stripNoise(sentence)).match(/[\p{L}'’]+/gu) ?? [];
    const capitalised = raw.filter((w) => /^\p{Lu}/u.test(w)).length;
    const titleCase = raw.length > 0 && capitalised / raw.length > 0.5;
    raw.forEach((word, index) => {
      if (!titleCase && index > 0 && /^\p{Lu}/u.test(word) && !isEnglishWord(word)) return;
      kept.push(word.toLowerCase().replace(/[’‘`]/g, "'").replace(/^'+|'+$/g, ""));
    });
  }
  return kept.filter((w) => w.length > 0);
}

const PROSE_KINDS = new Set<ContentKind>(["script", "subtitles", "description", "research", "text"]);

function detectWithFranc(text: string): { lang: string | null; score: number | null; englishScore: number | null } {
  const results = francAll(text, { only: FRANC_WHITELIST, minLength: 10 });
  const top = results[0];
  if (!top || top[0] === "und") return { lang: null, score: null, englishScore: null };
  const english = results.find(([code]) => code === "eng");
  return { lang: top[0], score: top[1], englishScore: english ? english[1] : 0 };
}

/** Analyses a single passage. Never throws. */
export function analyzeLanguage(input: string, kind: ContentKind = "text"): LanguageAnalysis {
  const text = input.normalize("NFC");
  const thresholds = THRESHOLDS[kind];
  const reasons: string[] = [];
  const { letters, nonLatin, diacritics } = letterStats(text);
  const words = tokenize(text);
  const nonLatinRatio = letters ? nonLatin / letters : 0;
  const diacriticRatio = letters ? diacritics / letters : 0;
  const wordRatio = englishWordRatio(PROSE_KINDS.has(kind) ? withoutProperNouns(text) : words);

  let franc = { lang: null as string | null, score: null as number | null, englishScore: null as number | null };
  const cleaned = stripNoise(text).trim();
  if (cleaned.length >= thresholds.francMinLength) franc = detectWithFranc(cleaned);

  const nonEnglishSentences: string[] = [];
  if (kind === "script" || kind === "subtitles" || kind === "description" || kind === "research") {
    for (const sentence of splitSentences(text)) {
      const sentenceWords = tokenize(sentence).filter((w) => w.length >= 2);
      if (sentenceWords.length < 4) continue;
      const stats = letterStats(sentence);
      const ratio = englishWordRatio(withoutProperNouns(sentence));
      const sentenceNonLatin = stats.letters ? stats.nonLatin / stats.letters : 0;
      if (sentenceNonLatin > 0.2 || ratio < 0.5) nonEnglishSentences.push(sentence.slice(0, 160));
    }
  }

  if (letters === 0) {
    return {
      isEnglish: kind === "hashtags" || kind === "tags",
      confidence: 0,
      reasons: ["text contains no letters"],
      metrics: {
        letters, nonLatinRatio, diacriticRatio, words: words.length, englishWordRatio: wordRatio,
        detectedLanguage: null, detectedScore: null, englishScore: null, nonEnglishSentences,
      },
    };
  }

  if (nonLatinRatio > 0.03) reasons.push(`${Math.round(nonLatinRatio * 100)}% of letters are not Latin script`);
  if (diacriticRatio > 0.06 || (diacriticRatio > 0.02 && wordRatio < 0.8)) reasons.push(`${Math.round(diacriticRatio * 100)}% of letters carry non-English diacritics`);
  if (wordRatio < thresholds.minEnglishWordRatio) {
    reasons.push(`only ${Math.round(wordRatio * 100)}% of words are English dictionary words`);
  }
  if (franc.lang && franc.lang !== "eng" && (franc.englishScore ?? 0) < 0.85 && wordRatio < 0.9) {
    reasons.push(`statistical detection suggests "${franc.lang}"`);
  }
  if (nonEnglishSentences.length > 0) {
    reasons.push(`${nonEnglishSentences.length} sentence(s) appear to be non-English`);
  }

  const isEnglish = reasons.length === 0;
  const confidence = Math.max(
    0,
    Math.min(1, wordRatio * (1 - nonLatinRatio * 5) * (1 - diacriticRatio * 5) * (franc.lang && franc.lang !== "eng" ? 0.8 : 1)),
  );

  return {
    isEnglish,
    confidence: Number(confidence.toFixed(3)),
    reasons,
    metrics: {
      letters,
      nonLatinRatio: Number(nonLatinRatio.toFixed(4)),
      diacriticRatio: Number(diacriticRatio.toFixed(4)),
      words: words.length,
      englishWordRatio: Number(wordRatio.toFixed(4)),
      detectedLanguage: franc.lang,
      detectedScore: franc.score,
      englishScore: franc.englishScore,
      nonEnglishSentences,
    },
  };
}

/** Analyses a list (hashtags, tags) by joining items; each item is also checked for non-Latin script. */
export function analyzeList(items: string[], kind: "hashtags" | "tags"): LanguageAnalysis {
  const analysis = analyzeLanguage(items.join(" "), kind);
  const offending = items.filter((item) => {
    const stats = letterStats(item);
    return stats.letters > 0 && (stats.nonLatin > 0 || stats.diacritics / stats.letters > 0.1);
  });
  if (offending.length > 0) {
    analysis.isEnglish = false;
    analysis.reasons.push(`non-English entries: ${offending.slice(0, 5).join(", ")}`);
  }
  return analysis;
}

/** Throws LanguageValidationError when `text` is not English. */
export function assertEnglish(text: string, kind: ContentKind, field: string = kind): LanguageAnalysis {
  const analysis = analyzeLanguage(text, kind);
  if (!analysis.isEnglish) throw new LanguageValidationError(field, analysis.reasons);
  return analysis;
}

export interface ContentBundle {
  topic?: string | null;
  research?: string | null;
  script?: string | null;
  title?: string | null;
  description?: string | null;
  hashtags?: string[] | null;
  tags?: string[] | null;
  subtitles?: string | null;
  thumbnail?: string | null;
}

export interface BundleReport {
  passed: boolean;
  fields: Record<string, LanguageAnalysis>;
  failedFields: string[];
}

/** Validates every present field of a content bundle (used by final pre-upload QA). */
export function validateBundle(bundle: ContentBundle): BundleReport {
  const fields: Record<string, LanguageAnalysis> = {};
  const check = (name: string, value: string | null | undefined, kind: ContentKind) => {
    if (value && value.trim()) fields[name] = analyzeLanguage(value, kind);
  };
  check("topic", bundle.topic, "topic");
  check("research", bundle.research, "research");
  check("script", bundle.script, "script");
  check("title", bundle.title, "title");
  check("description", bundle.description, "description");
  check("subtitles", bundle.subtitles, "subtitles");
  check("thumbnail", bundle.thumbnail, "thumbnail");
  if (bundle.hashtags?.length) fields.hashtags = analyzeList(bundle.hashtags, "hashtags");
  if (bundle.tags?.length) fields.tags = analyzeList(bundle.tags, "tags");
  const failedFields = Object.entries(fields)
    .filter(([, a]) => !a.isEnglish)
    .map(([name]) => name);
  return { passed: failedFields.length === 0, fields, failedFields };
}
