import { z } from "zod";
import type { Prisma, Topic } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { stableHash } from "@/lib/crypto";
import type { AIProvider, AIUsage, WebSource } from "@/services/ai/types";
import { analyzeLanguage } from "@/services/language/language-service";
import { CONTENT_POLICY_PROMPT, ENGLISH_ONLY_PROMPT } from "@/services/policy/content-policy";
import { getCached, setCached } from "@/services/cache/api-cache";
import { publisherName, sourceReliability } from "./source-reliability";

/**
 * ResearchService
 *
 * Purpose: collect reliable, sourced information about a topic before any factual
 * script is written, and classify each claim as an established fact, uncertain claim,
 * speculation or opinion.
 *
 * Provider: AIProvider.researchWithWebSearch (Claude + server-side web search) for live
 * sources, then a structured extraction pass that may only cite consulted URLs.
 * Output: persisted ResearchReference and ResearchClaim rows, topic.researchSummary,
 * and a verdict: COMPLETED (sufficient) or INSUFFICIENT.
 * Caching: results are cached per normalized topic for 30 days (ApiCache).
 */
export const researchExtractionSchema = z.object({
  summary: z.string().describe("A neutral English summary of what is reliably known (80-200 words)"),
  claims: z.array(
    z.object({
      statement: z.string(),
      type: z.enum(["ESTABLISHED_FACT", "UNCERTAIN", "SPECULATION", "OPINION"]),
      confidence: z.number().min(0).max(1),
      sourceUrls: z.array(z.string()),
    }),
  ),
  sufficient: z.boolean().describe("true if there are at least 3 well-sourced established facts to build a Short on"),
  recommendedAngle: z.string(),
  cautions: z.array(z.string()).describe("Myths, misconceptions or disputed points the script must avoid or label"),
});

export type ResearchExtraction = z.infer<typeof researchExtractionSchema>;

export interface ResearchOutcome {
  status: "COMPLETED" | "INSUFFICIENT";
  extraction: ResearchExtraction;
  sources: (WebSource & { reliability: number })[];
  usage: AIUsage;
  fromCache: boolean;
}

const RESEARCH_SYSTEM = `You are a meticulous fact-checker and researcher for an educational video channel.
Use web search to find authoritative sources (government agencies, universities, peer-reviewed journals,
encyclopaedias, major science publications). Prefer primary sources. Note where sources disagree.
Distinguish clearly between established facts, uncertain claims, speculation and opinion.
${ENGLISH_ONLY_PROMPT}
${CONTENT_POLICY_PROMPT}`;

const EXTRACTION_SYSTEM = `You convert research notes into a structured, strictly honest fact sheet.
Only cite URLs that appear in the provided source list. Never invent sources or facts.
Classify every claim: ESTABLISHED_FACT (well-documented by reliable sources), UNCERTAIN (limited or
conflicting evidence), SPECULATION (hypotheses, predictions), OPINION (subjective judgement).
${ENGLISH_ONLY_PROMPT}`;

const CACHE_NAMESPACE = "research";
const CACHE_TTL_SEC = 30 * 24 * 3600;
const MIN_FACTS = 3;

interface CachedResearch {
  extraction: ResearchExtraction;
  sources: (WebSource & { reliability: number })[];
}

export function assessSufficiency(extraction: ResearchExtraction, sources: { url: string; reliability: number }[]): boolean {
  const reliableUrls = new Set(sources.filter((s) => s.reliability >= 0.7).map((s) => s.url));
  const supportedFacts = extraction.claims.filter(
    (c) => c.type === "ESTABLISHED_FACT" && c.confidence >= 0.7 && c.sourceUrls.some((u) => reliableUrls.has(u)),
  );
  return extraction.sufficient && supportedFacts.length >= MIN_FACTS;
}

export async function researchTopic(opts: {
  topic: Topic;
  ai: AIProvider;
  signal?: AbortSignal;
  useCache?: boolean;
}): Promise<ResearchOutcome> {
  const { topic, ai } = opts;
  const cacheKey = `${CACHE_NAMESPACE}:${stableHash({ t: topic.normalizedTitle, a: topic.angle ?? "" })}`;
  const usage: AIUsage = { inputTokens: 0, outputTokens: 0, webSearches: 0, costUsd: 0, model: ai.model };

  let data: CachedResearch | null = opts.useCache === false ? null : await getCached<CachedResearch>(cacheKey);
  const fromCache = Boolean(data);

  if (!data) {
    const notes = await ai.researchWithWebSearch({
      system: RESEARCH_SYSTEM,
      prompt: [
        `Research this YouTube Short topic: "${topic.title}"`,
        topic.angle ? `Planned angle: ${topic.angle}` : "",
        "Find the key verifiable facts, specific numbers, dates and mechanisms, plus common misconceptions.",
        "Write concise research notes in English, citing sources.",
      ]
        .filter(Boolean)
        .join("\n"),
      maxSearches: 5,
      blockedDomains: ["reddit.com", "quora.com", "pinterest.com", "tiktok.com", "facebook.com"],
      signal: opts.signal,
    });
    addUsage(usage, notes.usage);

    const sources = notes.sources.map((s) => ({ ...s, reliability: sourceReliability(s.url) }));
    const extraction = await ai.generateStructured({
      purpose: "research.extract",
      system: EXTRACTION_SYSTEM,
      prompt: [
        `Topic: ${topic.title}`,
        "Sources consulted (the only URLs you may cite):",
        ...sources.map((s) => `- ${s.url} (${s.title})`),
        "",
        "Research notes:",
        notes.notes || "(no notes were produced)",
      ].join("\n"),
      schema: researchExtractionSchema,
      effort: "medium",
      signal: opts.signal,
    });
    addUsage(usage, extraction.usage);

    const allowedUrls = new Set(sources.map((s) => s.url));
    const cleaned: ResearchExtraction = {
      ...extraction.data,
      claims: extraction.data.claims.map((c) => ({ ...c, sourceUrls: c.sourceUrls.filter((u) => allowedUrls.has(u)) })),
    };
    data = { extraction: cleaned, sources };
    await setCached(cacheKey, CACHE_NAMESPACE, data, CACHE_TTL_SEC);
  }

  const language = analyzeLanguage(data.extraction.summary, "research");
  const sufficient = assessSufficiency(data.extraction, data.sources) && language.isEnglish;
  const status = sufficient ? "COMPLETED" : "INSUFFICIENT";

  await persistResearch(topic.id, status, data);
  return { status, extraction: data.extraction, sources: data.sources, usage, fromCache };
}

function addUsage(total: AIUsage, add: AIUsage): void {
  total.inputTokens += add.inputTokens;
  total.outputTokens += add.outputTokens;
  total.webSearches += add.webSearches;
  total.costUsd += add.costUsd;
}

async function persistResearch(topicId: string, status: "COMPLETED" | "INSUFFICIENT", data: CachedResearch) {
  await db.$transaction([
    db.researchReference.deleteMany({ where: { topicId } }),
    db.researchClaim.deleteMany({ where: { topicId } }),
    db.researchReference.createMany({
      data: data.sources.map((s) => ({
        topicId,
        title: s.title.slice(0, 500),
        url: s.url,
        publisher: publisherName(s.url),
        snippet: s.citedText?.slice(0, 1000) ?? null,
        reliability: s.reliability,
      })),
      skipDuplicates: true,
    }),
    db.researchClaim.createMany({
      data: data.extraction.claims.map((c) => ({
        topicId,
        statement: c.statement,
        type: c.type,
        confidence: c.confidence,
        sourceUrls: c.sourceUrls,
      })),
    }),
    db.topic.update({
      where: { id: topicId },
      data: {
        researchStatus: status,
        researchSummary: data.extraction.summary,
        researchData: {
          recommendedAngle: data.extraction.recommendedAngle,
          cautions: data.extraction.cautions,
        } as Prisma.InputJsonValue,
      },
    }),
  ]);
}

/** Loads persisted research as prompt context for script generation and fact checks. */
export async function loadResearchContext(topicId: string): Promise<{
  summary: string | null;
  facts: string[];
  uncertain: string[];
  cautions: string[];
  sources: string[];
}> {
  const topic = await db.topic.findUnique({
    where: { id: topicId },
    include: { claims: true, references: { orderBy: { reliability: "desc" } } },
  });
  if (!topic) return { summary: null, facts: [], uncertain: [], cautions: [], sources: [] };
  const researchData = (topic.researchData ?? {}) as { cautions?: string[] };
  return {
    summary: topic.researchSummary,
    facts: topic.claims.filter((c) => c.type === "ESTABLISHED_FACT").map((c) => c.statement),
    uncertain: topic.claims.filter((c) => c.type !== "ESTABLISHED_FACT").map((c) => `[${c.type}] ${c.statement}`),
    cautions: researchData.cautions ?? [],
    sources: topic.references.map((r) => r.url),
  };
}
