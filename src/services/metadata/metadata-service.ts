import { z } from "zod";
import type { AIProvider, AIUsage } from "@/services/ai/types";
import { mostSimilar } from "@/services/dedup/similarity";
import { analyzeLanguage, analyzeList } from "@/services/language/language-service";
import { checkContentPolicy, CONTENT_POLICY_PROMPT, ENGLISH_ONLY_PROMPT } from "@/services/policy/content-policy";
import { LanguageValidationError, ValidationError } from "@/lib/errors";

/**
 * MetadataService
 *
 * Purpose: generate the English YouTube title, description, hashtags, tags and
 * thumbnail text for a finished Short, then enforce YouTube limits and English-only
 * output programmatically. Regenerates (with the failure reasons) when a check fails.
 *
 * Limits enforced: title <= 50 chars (YouTube allows 100), description <= 5000 chars,
 * 3-5 hashtags including #Shorts, tags total <= 500 chars, thumbnail text <= 5 words.
 */
/** Short titles read fully in the Shorts feed; YouTube itself allows 100 characters. */
export const TITLE_MAX_CHARS = 50;

export const metadataSchema = z.object({
  title: z.string().describe(`Max ${TITLE_MAX_CHARS} characters`),
  description: z.string(),
  hashtags: z.array(z.string()),
  tags: z.array(z.string()),
  thumbnailText: z.string().describe("2-5 punchy English words for the thumbnail"),
});
export type VideoMetadata = z.infer<typeof metadataSchema>;

export interface MetadataContext {
  topicTitle: string;
  script: string;
  categoryName: string;
  sources: string[];
  recentTitles: string[];
}

const SYSTEM = `You write YouTube Shorts metadata that earns clicks honestly.
Titles are short (max 50 characters), spark curiosity without giving the whole fact away, and accurately represent the video.
No misleading clickbait, no ALL CAPS titles, no emoji spam.
${ENGLISH_ONLY_PROMPT}
${CONTENT_POLICY_PROMPT}`;

export function normalizeHashtag(tag: string): string | null {
  const cleaned = tag.replace(/^#+/, "").replace(/[^\p{L}\p{N}]/gu, "");
  return cleaned ? `#${cleaned}` : null;
}

/** Programmatic post-processing and limit enforcement. */
export function sanitizeMetadata(raw: VideoMetadata): VideoMetadata {
  let title = raw.title.replace(/\s+/g, " ").replace(/^["'“]+|["'”]+$/g, "").trim();
  if (title.length > 100) title = `${title.slice(0, 97).replace(/\s+\S*$/, "")}...`;

  const hashtags: string[] = [];
  for (const tag of raw.hashtags.map(normalizeHashtag)) {
    if (tag && !hashtags.some((h) => h.toLowerCase() === tag.toLowerCase())) hashtags.push(tag);
  }
  if (!hashtags.some((h) => h.toLowerCase() === "#shorts")) hashtags.push("#Shorts");
  const limitedHashtags = hashtags.slice(0, 5);

  const tags: string[] = [];
  let total = 0;
  for (const tag of raw.tags.map((t) => t.replace(/[<>#]/g, "").trim()).filter(Boolean)) {
    if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
    if (total + tag.length + 1 > 480) break;
    tags.push(tag.slice(0, 60));
    total += tag.length + 1;
  }

  const description = raw.description.replace(/<|>/g, "").trim().slice(0, 4500);
  const thumbnailText = raw.thumbnailText.replace(/\s+/g, " ").trim().split(" ").slice(0, 5).join(" ");
  return { title, description, hashtags: limitedHashtags, tags, thumbnailText };
}

export interface MetadataCheck {
  passed: boolean;
  reasons: string[];
}

export function checkMetadata(meta: VideoMetadata, recentTitles: string[]): MetadataCheck {
  const reasons: string[] = [];
  const title = analyzeLanguage(meta.title, "title");
  if (!title.isEnglish) reasons.push(`title not English (${title.reasons.join("; ")})`);
  const description = analyzeLanguage(meta.description, "description");
  if (!description.isEnglish) reasons.push(`description not English (${description.reasons.join("; ")})`);
  const hashtags = analyzeList(meta.hashtags, "hashtags");
  if (!hashtags.isEnglish) reasons.push(`hashtags not English (${hashtags.reasons.join("; ")})`);
  const tags = analyzeList(meta.tags, "tags");
  if (meta.tags.length && !tags.isEnglish) reasons.push(`tags not English (${tags.reasons.join("; ")})`);
  const thumb = analyzeLanguage(meta.thumbnailText, "thumbnail");
  if (meta.thumbnailText && !thumb.isEnglish) reasons.push(`thumbnail text not English (${thumb.reasons.join("; ")})`);
  if (meta.title.length < 10) reasons.push("title is too short");
  if (meta.title.length > TITLE_MAX_CHARS) reasons.push(`title is ${meta.title.length} characters; it must be at most ${TITLE_MAX_CHARS}`);
  if (meta.title === meta.title.toUpperCase() && /[A-Z]{6,}/.test(meta.title)) reasons.push("title is all caps");
  if (meta.description.length < 60) reasons.push("description is too short");
  const policy = checkContentPolicy(`${meta.title} ${meta.description}`);
  if (!policy.allowed) reasons.push(`content policy: ${policy.categories.join(", ")}`);
  const duplicate = mostSimilar(meta.title, recentTitles, (t) => t);
  if (duplicate && duplicate.score > 0.75) reasons.push(`title is too similar to an existing video: "${duplicate.item}"`);
  return { passed: reasons.length === 0, reasons };
}

export async function generateMetadata(
  ai: AIProvider,
  ctx: MetadataContext,
  options: { maxAttempts?: number; signal?: AbortSignal } = {},
): Promise<{ metadata: VideoMetadata; usage: AIUsage; attempts: number }> {
  const maxAttempts = options.maxAttempts ?? 3;
  const usage: AIUsage = { inputTokens: 0, outputTokens: 0, webSearches: 0, costUsd: 0, model: ai.model };
  let feedback: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await ai.generateStructured({
      purpose: "metadata.generate",
      system: SYSTEM,
      prompt: [
        `Create YouTube Shorts metadata for this video (category: ${ctx.categoryName}).`,
        `Topic: ${ctx.topicTitle}`,
        `Narration script:\n"""${ctx.script}"""`,
        `Title: max ${TITLE_MAX_CHARS} characters; it makes people curious but does not reveal the whole fact. Accurate, no clickbait. Description: 2-4 natural sentences summarising the video,`,
        "then one line inviting viewers to follow for more. Hashtags: 3-5 relevant CamelCase hashtags including #Shorts.",
        "Tags: 8-15 relevant search keywords. Thumbnail text: 2-5 words.",
        ctx.recentTitles.length ? `Do not reuse these existing titles:\n- ${ctx.recentTitles.slice(0, 30).join("\n- ")}` : "",
        feedback.length ? `The previous attempt was rejected because: ${feedback.join("; ")}. Fix these problems.` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      schema: metadataSchema,
      effort: "low",
      signal: options.signal,
    });
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    usage.costUsd += result.usage.costUsd;

    const metadata = sanitizeMetadata(result.data);
    const check = checkMetadata(metadata, ctx.recentTitles);
    if (check.passed) return { metadata, usage, attempts: attempt };
    feedback = check.reasons;
  }
  if (feedback.some((r) => r.includes("not English"))) throw new LanguageValidationError("metadata", feedback);
  throw new ValidationError(`Metadata failed validation: ${feedback.join("; ")}`);
}

/** Final description with attribution for licensed media, and hashtags appended. */
export function composeDescription(
  meta: Pick<VideoMetadata, "description" | "hashtags">,
  opts: { credits: string[]; appendHashtags: boolean },
): string {
  const parts = [meta.description.trim()];
  if (opts.credits.length) parts.push(`Credits:\n${opts.credits.join("\n")}`);
  if (opts.appendHashtags && meta.hashtags.length) parts.push(meta.hashtags.join(" "));
  return parts.join("\n\n").slice(0, 5000);
}
