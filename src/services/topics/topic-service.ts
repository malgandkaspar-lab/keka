import { z } from "zod";
import type { Topic } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import type { AIProvider, AIUsage } from "@/services/ai/types";
import { mostSimilar, normalizeText } from "@/services/dedup/similarity";
import { analyzeLanguage, assertEnglish } from "@/services/language/language-service";
import { assertContentAllowed, checkContentPolicy, CONTENT_POLICY_PROMPT, ENGLISH_ONLY_PROMPT } from "@/services/policy/content-policy";

/**
 * TopicService
 *
 * Purpose: produce the topic for a Short, either from user input (manual) or selected
 * autonomously by the AI (automatic).
 *
 * Automatic selection asks the AI for several candidates, each scored on curiosity,
 * novelty, educational value, entertainment, visual potential, short-form potential and
 * factual verifiability. Candidates are then filtered programmatically: English-only,
 * content policy, minimum score and similarity against the user's topic history.
 *
 * Errors: ValidationError (bad manual input), ContentPolicyError, ConflictError (every
 * candidate was a near-duplicate), ExternalServiceError from the AI provider.
 */
export const TOPIC_SCORE_WEIGHTS = {
  curiosity: 0.2,
  novelty: 0.15,
  educationalValue: 0.15,
  entertainment: 0.12,
  visualPotential: 0.15,
  shortFormPotential: 0.1,
  factualVerifiability: 0.13,
} as const;

const scoreField = z.number().min(0).max(10);

export const topicCandidateSchema = z.object({
  title: z.string().describe("The topic phrased as a compelling question or statement, in English"),
  angle: z.string().describe("The specific angle / surprising insight the Short will deliver"),
  scores: z.object({
    curiosity: scoreField,
    novelty: scoreField,
    educationalValue: scoreField,
    entertainment: scoreField,
    visualPotential: scoreField,
    shortFormPotential: scoreField,
    factualVerifiability: scoreField,
  }),
  visualIdeas: z.array(z.string()).describe("Stock-footage friendly visual ideas"),
});

const topicCandidatesSchema = z.object({ candidates: z.array(topicCandidateSchema) });

export type TopicCandidate = z.infer<typeof topicCandidateSchema>;
export type TopicScores = TopicCandidate["scores"];

export function overallScore(scores: TopicScores): number {
  let total = 0;
  for (const [key, weight] of Object.entries(TOPIC_SCORE_WEIGHTS)) {
    total += (scores[key as keyof TopicScores] ?? 0) * weight;
  }
  return Number(total.toFixed(2));
}

export interface TopicGenerationOptions {
  userId: string;
  projectId?: string | null;
  categoryKey: string;
  ai: AIProvider;
  minScore: number;
  similarityThreshold: number;
  historyLimit?: number;
  extraAvoid?: string[];
  performanceHints?: string[];
  signal?: AbortSignal;
}

export interface TopicGenerationResult {
  topic: Topic;
  usage: AIUsage;
  rejected: { title: string; reason: string }[];
}

async function loadCategory(categoryKey: string) {
  const category = await db.topicCategory.findUnique({ where: { key: categoryKey } });
  if (!category || !category.enabled) throw new NotFoundError("Topic category", categoryKey);
  return category;
}

export async function recentTopicTitles(userId: string, limit = 150): Promise<string[]> {
  const [topics, videos] = await Promise.all([
    db.topic.findMany({
      where: { userId, status: { not: "REJECTED" } },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { title: true },
    }),
    db.video.findMany({
      where: { userId, title: { not: null } },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { title: true },
    }),
  ]);
  return [...topics.map((t) => t.title), ...videos.map((v) => v.title!).filter(Boolean)];
}

function buildTopicPrompt(opts: {
  categoryName: string;
  categoryHints: string | null;
  avoid: string[];
  performanceHints: string[];
  count: number;
}): string {
  return [
    `Propose ${opts.count} distinct YouTube Shorts topics in the category "${opts.categoryName}".`,
    opts.categoryHints ? `Category guidance: ${opts.categoryHints}` : "",
    "Each topic must be answerable with well-documented, verifiable facts in 15-60 seconds of narration,",
    "and must be easy to illustrate with generic stock footage (no specific copyrighted characters or footage).",
    "Score every candidate honestly from 0 to 10 on: curiosity, novelty, educationalValue, entertainment,",
    "visualPotential, shortFormPotential and factualVerifiability. Do not inflate scores.",
    opts.performanceHints.length
      ? `What has performed well on this channel before (use as soft guidance, never copy):\n- ${opts.performanceHints.join("\n- ")}`
      : "",
    opts.avoid.length
      ? `Do NOT propose anything similar to these existing topics:\n- ${opts.avoid.slice(0, 80).join("\n- ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const TOPIC_SYSTEM = `You are the head of content for an educational YouTube Shorts channel.
You pick topics that make viewers think "wait, really?" and that are 100% truthful.
${ENGLISH_ONLY_PROMPT}
${CONTENT_POLICY_PROMPT}`;

interface CandidateVerdict {
  candidate: TopicCandidate;
  score: number;
  reason?: string;
}

export function evaluateCandidates(
  candidates: TopicCandidate[],
  history: string[],
  minScore: number,
  similarityThreshold: number,
): CandidateVerdict[] {
  const accepted: string[] = [];
  return candidates.map((candidate) => {
    const score = overallScore(candidate.scores);
    const text = `${candidate.title} ${candidate.angle}`;
    const language = analyzeLanguage(candidate.title, "topic");
    if (!language.isEnglish) return { candidate, score, reason: `not English: ${language.reasons.join("; ")}` };
    const policy = checkContentPolicy(text);
    if (!policy.allowed) return { candidate, score, reason: `content policy: ${policy.categories.join(", ")}` };
    if (score < minScore) return { candidate, score, reason: `score ${score} below minimum ${minScore}` };
    if (candidate.scores.factualVerifiability < 6) return { candidate, score, reason: "not verifiable enough" };
    const duplicate = mostSimilar(candidate.title, [...history, ...accepted], (t) => t);
    if (duplicate && duplicate.score >= similarityThreshold) {
      return { candidate, score, reason: `too similar to "${duplicate.item}" (${duplicate.score})` };
    }
    accepted.push(candidate.title);
    return { candidate, score };
  });
}

/** AI-selected topic with deduplication against history. */
export async function generateTopic(opts: TopicGenerationOptions): Promise<TopicGenerationResult> {
  const category = await loadCategory(opts.categoryKey);
  const history = [...(await recentTopicTitles(opts.userId, opts.historyLimit)), ...(opts.extraAvoid ?? [])];
  const rejected: { title: string; reason: string }[] = [];
  const usage: AIUsage = { inputTokens: 0, outputTokens: 0, webSearches: 0, costUsd: 0, model: opts.ai.model };

  for (let round = 0; round < 3; round++) {
    const result = await opts.ai.generateStructured({
      purpose: "topic.generate",
      system: TOPIC_SYSTEM,
      prompt: buildTopicPrompt({
        categoryName: category.name,
        categoryHints: category.promptHints,
        avoid: [...history, ...rejected.map((r) => r.title)],
        performanceHints: opts.performanceHints ?? [],
        count: 6,
      }),
      schema: topicCandidatesSchema,
      effort: "medium",
      signal: opts.signal,
    });
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    usage.costUsd += result.usage.costUsd;

    const verdicts = evaluateCandidates(result.data.candidates, history, opts.minScore, opts.similarityThreshold);
    for (const v of verdicts) if (v.reason) rejected.push({ title: v.candidate.title, reason: v.reason });
    const best = verdicts.filter((v) => !v.reason).sort((a, b) => b.score - a.score)[0];
    if (best) {
      const topic = await db.topic.create({
        data: {
          userId: opts.userId,
          projectId: opts.projectId ?? null,
          category: category.key,
          title: best.candidate.title.trim(),
          angle: best.candidate.angle.trim(),
          normalizedTitle: normalizeText(best.candidate.title),
          source: "AI",
          scores: { ...best.candidate.scores, visualIdeas: best.candidate.visualIdeas },
          overallScore: best.score,
        },
      });
      return { topic, usage, rejected };
    }
  }
  throw new ConflictError("Could not find a sufficiently novel, high-quality topic after 3 attempts", { rejected });
}

export const manualTopicSchema = z.object({
  title: z.string().trim().min(8, "Topic is too short").max(200, "Topic is too long"),
  category: z.string().min(1),
});

/** Manually entered topic: validated for English and content policy; duplicates are reported. */
export async function createManualTopic(input: {
  userId: string;
  projectId?: string | null;
  title: string;
  categoryKey: string;
  similarityThreshold: number;
}): Promise<{ topic: Topic; similarTo: string | null }> {
  const parsed = manualTopicSchema.safeParse({ title: input.title, category: input.categoryKey });
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid topic");
  await loadCategory(input.categoryKey);
  assertEnglish(parsed.data.title, "topic", "Topic");
  assertContentAllowed(parsed.data.title, "topic");
  const history = await recentTopicTitles(input.userId);
  const duplicate = mostSimilar(parsed.data.title, history, (t) => t);
  const topic = await db.topic.create({
    data: {
      userId: input.userId,
      projectId: input.projectId ?? null,
      category: input.categoryKey,
      title: parsed.data.title,
      normalizedTitle: normalizeText(parsed.data.title),
      source: "MANUAL",
    },
  });
  return {
    topic,
    similarTo: duplicate && duplicate.score >= input.similarityThreshold ? duplicate.item : null,
  };
}

export async function markTopicUsed(topicId: string): Promise<void> {
  await db.topic.update({ where: { id: topicId }, data: { status: "USED" } });
}

export async function rejectTopic(topicId: string): Promise<void> {
  await db.topic.update({ where: { id: topicId }, data: { status: "REJECTED" } });
}
