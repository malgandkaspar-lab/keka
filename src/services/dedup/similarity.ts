/**
 * Text similarity utilities used for deduplication of topics, titles and scripts.
 *
 * similarity() combines:
 *  - Jaccard similarity of content-word sets (robust to reordering)
 *  - cosine similarity of character trigram vectors (robust to inflection/typos)
 * and returns a value in [0, 1].
 */
const STOP_WORDS = new Set(
  "a an the and or but if then so of to in on at by for with from about as into over under is are was were be been being do does did has have had this that these those it its it's you your we our they their he she his her i me my what why how when where who which can could would should will just really very more most than too not no yes there here all any some one two three why's what's how's".split(
    " ",
  ),
);

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stem(word: string): string {
  return word.replace(/(ing|ed|es|s)$/u, "");
}

export function contentWords(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    .map(stem);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function trigrams(text: string): Map<string, number> {
  const padded = `  ${normalizeText(text)}  `;
  const grams = new Map<string, number>();
  for (let i = 0; i < padded.length - 2; i++) {
    const gram = padded.slice(i, i + 3);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [key, value] of a) {
    normA += value * value;
    const other = b.get(key);
    if (other) dot += value * other;
  }
  for (const value of b.values()) normB += value * value;
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

export function similarity(a: string, b: string): number {
  const wordScore = jaccard(new Set(contentWords(a)), new Set(contentWords(b)));
  const charScore = cosine(trigrams(a), trigrams(b));
  return Number((0.55 * wordScore + 0.45 * charScore).toFixed(4));
}

export interface SimilarMatch<T> {
  item: T;
  score: number;
}

export function mostSimilar<T>(text: string, candidates: T[], getText: (item: T) => string): SimilarMatch<T> | null {
  let best: SimilarMatch<T> | null = null;
  for (const item of candidates) {
    const score = similarity(text, getText(item));
    if (!best || score > best.score) best = { item, score };
  }
  return best;
}

/** Share of repeated word 4-grams inside a single text (0 = no repetition). */
export function internalRepetition(text: string, n = 4): number {
  const words = normalizeText(text).split(" ").filter(Boolean);
  if (words.length < n * 2) return 0;
  const seen = new Map<string, number>();
  for (let i = 0; i <= words.length - n; i++) {
    const gram = words.slice(i, i + n).join(" ");
    seen.set(gram, (seen.get(gram) ?? 0) + 1);
  }
  let repeated = 0;
  for (const count of seen.values()) if (count > 1) repeated += count - 1;
  return repeated / (words.length - n + 1);
}
