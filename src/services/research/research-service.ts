import { z } from "zod";
import type { Prisma, Topic } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { stableHash } from "@/lib/crypto";
import type { AIProvider, AIUsage, WebSource } from "@/services/ai/types";
import { analyzeLanguage } from "@/services/language/language-service";
import { CONTENT_POLICY_PROMPT, ENGLISH_ONLY_PROMPT } from "@/services/policy/content-policy";
import { getCached, setCached } from "@/services/cache/api-cache";
import { similarity } from "@/services/dedup/similarity";
import { countWords } from "@/services/scripts/duration";
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

const FACT_LIST_SYSTEM = `You copy concrete facts out of research notes. Every fact must be stated in the notes;
never add anything from memory. One fact per item: a single short English sentence with specific
names, numbers, dates or mechanisms.
${ENGLISH_ONLY_PROMPT}`;

const factListSchema = z.object({
  facts: z.array(
    z.object({
      statement: z.string().describe("One concrete fact, close to the wording of the notes"),
      source: z.number().int().describe("Number of the source the fact comes from"),
    }),
  ),
});

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
  // An insufficient result is never reused: research it again (sources or models may do better).
  if (data && !assessSufficiency(data.extraction, data.sources)) data = null;
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
    let cleaned: ResearchExtraction = {
      ...extraction.data,
      claims: extraction.data.claims.map((c) => ({ ...c, sourceUrls: c.sourceUrls.filter((u) => allowedUrls.has(u)) })),
    };
    if (!assessSufficiency(cleaned, sources) && notes.notes.length >= 300) {
      // Smaller (local) models often return an empty or unusable fact sheet. A simpler
      // "copy the facts out" pass, verified word by word against the notes, recovers them.
      const listed = await ai.generateStructured({
        purpose: "research.facts",
        system: FACT_LIST_SYSTEM,
        prompt: [
          `Topic: ${topic.title}`,
          "Sources:",
          ...sources.map((s, i) => `[${i + 1}] ${s.title} (${s.url})`),
          "",
          "Research notes:",
          notes.notes,
          "",
          "List 6 to 10 specific facts from these notes that are relevant to the topic. For each fact give the number of its source.",
        ].join("\n"),
        schema: factListSchema,
        effort: "low",
        signal: opts.signal,
      });
      addUsage(usage, listed.usage);
      cleaned = mergeGroundedFacts(cleaned, listed.data.facts, notes.notes, sources);
    }
    data = { extraction: cleaned, sources };
    if (assessSufficiency(cleaned, sources)) await setCached(cacheKey, CACHE_NAMESPACE, data, CACHE_TTL_SEC);
  }

  const language = analyzeLanguage(data.extraction.summary, "research");
  const sufficient = assessSufficiency(data.extraction, data.sources) && language.isEnglish;
  const status = sufficient ? "COMPLETED" : "INSUFFICIENT";

  await persistResearch(topic.id, status, data);
  return { status, extraction: data.extraction, sources: data.sources, usage, fromCache };
}

const STOPWORDS = new Set(
  "the and that this with from were was are for have has had been its it's their they them than then into onto over under about which while also only more most some such very can could would should will may might not but all any each other there these those what when where who why how".split(" "),
);

function normalizeToken(token: string): string {
  const t = token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t;
}

/**
 * True when a statement is supported by the text word for word: every number in it
 * appears in the text and at least 75% of its content words do.
 */
export function isGroundedIn(statement: string, text: string): boolean {
  const corpus = new Set(text.replace(/(\d),(\d)/g, "$1$2").split(/\s+/).map(normalizeToken).filter(Boolean));
  const tokens = statement.replace(/(\d),(\d)/g, "$1$2").split(/\s+/).map(normalizeToken).filter(Boolean);
  const numbers = tokens.filter((t) => /\d/.test(t));
  if (numbers.some((n) => !corpus.has(n))) return false;
  const words = tokens.filter((t) => !/\d/.test(t) && t.length > 2 && !STOPWORDS.has(t));
  if (words.length < 3) return false;
  return words.filter((w) => corpus.has(w)).length / words.length >= 0.75;
}

/** Adds listed facts that are verifiably grounded in the notes as established facts. */
export function mergeGroundedFacts(
  extraction: ResearchExtraction,
  facts: { statement: string; source: number }[],
  notes: string,
  sources: { url: string; reliability: number }[],
): ResearchExtraction {
  const claims = [...extraction.claims];
  for (const fact of facts) {
    const statement = fact.statement.replace(/\s+/g, " ").trim();
    if (!isGroundedIn(statement, notes)) continue;
    if (claims.some((c) => similarity(c.statement, statement) > 0.8)) continue;
    const source = sources[fact.source - 1];
    claims.push({ statement, type: "ESTABLISHED_FACT", confidence: 0.8, sourceUrls: source ? [source.url] : [] });
  }
  const merged: ResearchExtraction = { ...extraction, claims, sufficient: true };
  const established = claims.filter((c) => c.type === "ESTABLISHED_FACT").map((c) => c.statement);
  if (countWords(merged.summary) < 20 && established.length) merged.summary = established.slice(0, 6).join(" ");
  return { ...merged, sufficient: extraction.sufficient || assessSufficiency(merged, sources) };
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
