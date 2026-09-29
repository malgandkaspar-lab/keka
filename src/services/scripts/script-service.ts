import { z } from "zod";
import type { Prisma, ScriptVersion } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import type { AIProvider, AIUsage } from "@/services/ai/types";
import { internalRepetition, similarity } from "@/services/dedup/similarity";
import { analyzeLanguage } from "@/services/language/language-service";
import { checkContentPolicy, CONTENT_POLICY_PROMPT, ENGLISH_ONLY_PROMPT } from "@/services/policy/content-policy";
import { countWords, estimateSpeechDurationSec, targetWordCount } from "./duration";

/**
 * ScriptService
 *
 * Purpose: write, validate and revise narration scripts for YouTube Shorts in the
 * one-fact format:
 *   HOOK        - the fact itself in the first sentence (max 12 words, no intro, not a question)
 *   CURIOSITY   - one surprising detail that keeps people watching
 *   INFORMATION - 2-3 short sentences explaining why it is true
 *   CTA         - a question to the viewer that is easy to answer in the comments
 * Length: 60-90 words (about 25-35 seconds); every version stores its estimated duration.
 * Quality control: programmatic checks (English, length, hook, single fact, closing
 * question, pacing, repetition, formatting, policy) plus an AI review (grammar, facts
 * against the research, single fact, hook states the fact, suitability). Failed scripts
 * are revised automatically until they pass or attempts run out.
 */
/** ESCALATION and PAYOFF belong to the earlier format; they remain valid for stored versions. */
export const SECTION_TYPES = ["HOOK", "CURIOSITY", "INFORMATION", "ESCALATION", "PAYOFF", "CTA"] as const;
export const HOOK_STYLES = ["curiosity", "contrarian", "question", "unexpected_fact", "story", "challenge", "number"] as const;

export const SCRIPT_MIN_WORDS = 60;
export const SCRIPT_MAX_WORDS = 90;
/** Shortest script accepted as a last resort (allowShorter). */
const MIN_ACCEPTABLE_WORDS = 50;
const MAX_HOOK_WORDS = 12;

export const scriptDraftSchema = z.object({
  hookStyle: z.enum(HOOK_STYLES),
  sections: z
    .array(
      z.object({
        type: z.enum(SECTION_TYPES),
        text: z.string().describe("Narration exactly as it will be spoken"),
      }),
    )
    .describe("Ordered sections: HOOK, CURIOSITY, INFORMATION, CTA"),
  factsUsed: z.array(z.string()).describe("The one researched fact the script is built on"),
});
export type ScriptDraft = z.infer<typeof scriptDraftSchema>;

export const scriptReviewSchema = z.object({
  grammarAndSpellingOk: z.boolean(),
  factuallyConsistent: z.boolean().describe("Every claim is supported by the research facts"),
  unsupportedClaims: z.array(z.string()),
  inappropriateContent: z.boolean(),
  misleadingHook: z.boolean().describe("The hook overpromises or misrepresents the video"),
  singleFact: z.boolean().describe("The whole script is built around exactly one fact, with no list of facts"),
  hookStatesFact: z.boolean().describe("The first sentence states the fact itself, without an intro"),
  hookScore: z.number().min(0).max(10),
  conclusionScore: z.number().min(0).max(10).describe("How easy and tempting the closing question is to answer in the comments"),
  shortsSuitabilityScore: z.number().min(0).max(10),
  issues: z.array(z.string()),
});
export type ScriptReview = z.infer<typeof scriptReviewSchema>;

export interface ScriptContext {
  topicTitle: string;
  topicAngle?: string | null;
  categoryName: string;
  research: { summary: string | null; facts: string[]; uncertain: string[]; cautions: string[] };
  targetDurationSec: number;
  wordsPerMinute: number;
  tolerancePct: number;
  pacing: "fast" | "measured" | "calm";
  tone: string;
  includeCta: boolean;
  recentHooks: string[];
  preferredHookStyles?: string[];
  /** Last resort: accept a script that is somewhat shorter than planned with a warning. */
  allowShorter?: boolean;
}

export interface ValidationIssue {
  check: string;
  severity: "error" | "warning";
  message: string;
}

export interface ScriptValidation {
  passed: boolean;
  issues: ValidationIssue[];
  metrics: {
    wordCount: number;
    estimatedDurationSec: number;
    targetDurationSec: number;
    hookWords: number;
    repetition: number;
    englishConfidence: number;
  };
  review?: ScriptReview;
}

const SCRIPT_SYSTEM = `You write scripts for YouTube Shorts, each built around ONE surprising, well-documented fact.
You talk like you are telling a friend something amazing: simple spoken English, short sentences,
concrete numbers and vivid comparisons, no filler. You only use facts that are well documented and
verifiable. You never exaggerate or repeat myths; if you are not sure a fact is accurate, you choose another one.
Formatting rules: plain spoken narration only - no stage directions, no brackets, no emojis,
no hashtags, no URLs, no speaker labels, no markdown.
${ENGLISH_ONLY_PROMPT}
${CONTENT_POLICY_PROMPT}`;

const REVIEW_SYSTEM = `You are a strict script editor and fact-checker for YouTube Shorts.
Judge the script only against the provided research. A claim that is not supported by the research
facts is "unsupported". Be precise and concise.
${ENGLISH_ONLY_PROMPT}`;

export function fullText(draft: Pick<ScriptDraft, "sections">): string {
  return draft.sections
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/** Word budget: the one-fact format is 60-90 words; the aim follows the requested duration within that range. */
export function scriptWordBudget(ctx: Pick<ScriptContext, "targetDurationSec" | "wordsPerMinute">): { min: number; target: number; max: number } {
  const fromDuration = targetWordCount(ctx.targetDurationSec, ctx.wordsPerMinute).target;
  return { min: SCRIPT_MIN_WORDS, target: Math.min(85, Math.max(65, fromDuration)), max: SCRIPT_MAX_WORDS };
}

function describePacing(pacing: ScriptContext["pacing"]): string {
  switch (pacing) {
    case "fast":
      return "Fast, punchy delivery: short sentences, no pauses for filler.";
    case "measured":
      return "Measured, cinematic delivery: vary the rhythm but keep every sentence short.";
    case "calm":
      return "Calm, clear delivery: conversational sentences, one idea at a time.";
  }
}

function formatRules(ctx: ScriptContext): string[] {
  const words = scriptWordBudget(ctx);
  return [
    "FORMAT - follow every rule:",
    '1. ONE fact for the whole video. No lists and no second fact. If the topic asks for several facts (for example "5 facts about X"), pick the single most surprising one.',
    `2. HOOK: the first sentence states the fact itself in max ${MAX_HOOK_WORDS} words and makes the viewer think "wait, what?!". It is a statement, not a question. Never open with an intro such as "Did you know", "Here's a fun fact", "Today", "Nowadays" or "Have you ever wondered".`,
    "3. CURIOSITY: the second sentence adds one surprising detail that makes people keep watching.",
    "4. INFORMATION: then 2-3 short sentences that explain WHY it is true.",
    "5. CTA: the last sentence is a question to the viewer that is easy to answer in the comments, such as a choice or a yes/no question.",
    `6. Length: ${words.min}-${words.max} words in total (aim for ${words.target}). Short sentences, like talking to a friend.`,
    "7. Use ONLY well-documented facts from the research below. No exaggeration and no myths. If a fact is uncertain, choose another one.",
  ];
}

interface SentencePlan {
  /** Sentences in the INFORMATION ("why") section. */
  why: number;
}

const HOOK_WORDS = 10;
const DETAIL_WORDS = 13;
const QUESTION_WORDS = 10;
const WHY_SENTENCE_WORDS = 13;

function whySentences(ctx: ScriptContext, wordsPerWhySentence: number, otherWords: number): SentencePlan {
  const target = scriptWordBudget(ctx).target;
  return { why: Math.max(2, Math.min(3, Math.round((target - otherWords) / Math.max(5, wordsPerWhySentence)))) };
}

function planFor(ctx: ScriptContext): SentencePlan {
  return whySentences(ctx, WHY_SENTENCE_WORDS, HOOK_WORDS + DETAIL_WORDS + QUESTION_WORDS);
}

/** Sentence plan per section: small models follow sentence counts far better than word counts. */
function describePlan(plan: SentencePlan): string {
  return [
    "Section plan:",
    `- HOOK: 1 sentence, max ${MAX_HOOK_WORDS} words - the fact itself`,
    "- CURIOSITY: 1 sentence - the surprising detail",
    `- INFORMATION: ${plan.why} sentences - why it is true`,
    "- CTA: 1 question to the viewer",
  ].join("\n");
}

function sectionPlan(ctx: ScriptContext): string {
  return describePlan(planFor(ctx));
}

/**
 * Output schema with an exact sentence count per section. Local models decode with a
 * JSON grammar, so fixed-length arrays make the structure and length reliable.
 */
function sentenceSchema(plan: SentencePlan) {
  return z.object({
    hookStyle: z.enum(HOOK_STYLES),
    hook: z.string().describe(`The fact itself in one sentence of max ${MAX_HOOK_WORDS} words, not a question`),
    detail: z.string().describe("One sentence with a surprising detail"),
    why: z.array(z.string().describe("One short sentence of 10-16 words explaining why")).length(plan.why),
    question: z.string().describe("One question to the viewer that is easy to answer in the comments"),
    factsUsed: z.array(z.string()),
  });
}

type SentenceDraft = z.infer<ReturnType<typeof sentenceSchema>>;

function draftFromSentences(data: SentenceDraft): ScriptDraft {
  const sections: ScriptDraft["sections"] = [
    { type: "HOOK", text: data.hook.trim() },
    { type: "CURIOSITY", text: data.detail.trim() },
    { type: "INFORMATION", text: data.why.map((s) => s.trim()).filter(Boolean).join(" ") },
    { type: "CTA", text: data.question.trim() },
  ];
  return { hookStyle: data.hookStyle, sections: sections.filter((section) => section.text), factsUsed: data.factsUsed };
}

/** Re-plans the number of "why" sentences from the sentence length the model actually writes. */
function replan(ctx: ScriptContext, draft: ScriptDraft): SentencePlan {
  const why = draft.sections.filter((s) => s.type === "INFORMATION").map((s) => s.text).join(" ");
  const other = draft.sections.filter((s) => s.type !== "INFORMATION").map((s) => s.text).join(" ");
  const perSentence = countWords(why) / Math.max(1, sentencesOf(why).length);
  return whySentences(ctx, perSentence, countWords(other));
}

function researchLines(ctx: ScriptContext): string[] {
  return [
    "Research you may rely on (use ONLY these facts; do not add facts from memory):",
    ...(ctx.research.facts.length ? ctx.research.facts.map((f) => `- ${f}`) : ["- (no verified facts available: keep claims general and clearly hedged)"]),
    ctx.research.uncertain.length ? `Uncertain points - do NOT build the video on these:\n- ${ctx.research.uncertain.join("\n- ")}` : "",
    ctx.research.cautions.length ? `Misconceptions to avoid:\n- ${ctx.research.cautions.join("\n- ")}` : "",
  ].filter(Boolean);
}

function buildScriptPrompt(ctx: ScriptContext, revision?: { previous: string; issues: string[] }): string {
  const lines = [
    "Write a YouTube Short narration script.",
    `Topic: ${ctx.topicTitle}`,
    ctx.topicAngle ? `Angle: ${ctx.topicAngle}` : "",
    `Category: ${ctx.categoryName}`,
    `Tone: ${ctx.tone}. ${describePacing(ctx.pacing)}`,
    ...formatRules(ctx),
    "Return the sections in this order: HOOK, CURIOSITY, INFORMATION, CTA.",
    sectionPlan(ctx),
    ctx.preferredHookStyles?.length ? `Hook styles that have performed well: ${ctx.preferredHookStyles.join(", ")}.` : "",
    ctx.recentHooks.length ? `Avoid reusing these recent hooks or their wording:\n- ${ctx.recentHooks.slice(0, 15).join("\n- ")}` : "",
    "",
    ...researchLines(ctx),
  ];
  if (revision) {
    lines.push(
      "",
      "REVISION: the previous draft failed quality control. Fix every issue below while keeping what worked.",
      `Previous draft:\n"""${revision.previous}"""`,
      `Issues to fix:\n- ${revision.issues.join("\n- ")}`,
    );
  }
  return lines.filter(Boolean).join("\n");
}

const MAX_FIT_PASSES = 2;

function normaliseDraft(draft: ScriptDraft): ScriptDraft {
  // The first section must be the hook.
  if (draft.sections[0] && draft.sections[0].type !== "HOOK") draft.sections[0] = { ...draft.sections[0], type: "HOOK" };
  return draft;
}

/** Length fitting only makes sense for an English draft; anything else goes to QC and revision. */
function needsLengthFit(draft: ScriptDraft, ctx: ScriptContext): boolean {
  const text = fullText(draft);
  if (!analyzeLanguage(text, "script").isEnglish) return false;
  const words = countWords(text);
  const budget = scriptWordBudget(ctx);
  return words < budget.min || words > budget.max;
}

/** How far a draft's length is from the word target. */
function lengthGap(draft: ScriptDraft, ctx: ScriptContext): number {
  return Math.abs(countWords(fullText(draft)) - scriptWordBudget(ctx).target);
}

function buildFitPrompt(ctx: ScriptContext, draft: ScriptDraft): string {
  const words = scriptWordBudget(ctx);
  const current = countWords(fullText(draft));
  const tooShort = current < words.target;
  const delta = Math.abs(words.target - current);
  return [
    `This YouTube Short script about "${ctx.topicTitle}" has ${current} words, but it must have ${words.min}-${words.max} words (aim for ${words.target}).`,
    tooShort
      ? `Make it LONGER: add about ${delta} words. Keep the hook and the closing question. Expand the CURIOSITY detail and the INFORMATION explanation (2-3 sentences) with concrete details and the reason why.`
      : `Make it SHORTER: remove about ${delta} words. Keep the hook, the one fact and the closing question; cut the least important details.`,
    "Keep the one-fact format and English style. Return the complete revised script.",
    ...formatRules(ctx),
    sectionPlan(ctx),
    "",
    ...researchLines(ctx),
    "",
    "Current script:",
    ...draft.sections.map((s) => `${s.type}: ${s.text}`),
  ].join("\n");
}

export async function draftScript(
  ai: AIProvider,
  ctx: ScriptContext,
  revision?: { previous: string; issues: string[] },
  signal?: AbortSignal,
): Promise<{ draft: ScriptDraft; usage: AIUsage }> {
  if (ai.prefersSimpleOutput) return draftWithSentencePlan(ai, ctx, revision, signal);
  const result = await ai.generateStructured({
    purpose: revision ? "script.revise" : "script.generate",
    system: SCRIPT_SYSTEM,
    prompt: buildScriptPrompt(ctx, revision),
    schema: scriptDraftSchema,
    effort: "high",
    signal,
  });
  const usage = { ...result.usage };
  let draft = normaliseDraft(result.data);
  // Length fitting: models (especially small local ones) often miss the word budget.
  for (let pass = 0; pass < MAX_FIT_PASSES; pass++) {
    if (!needsLengthFit(draft, ctx)) break;
    const fitted = await ai.generateStructured({
      purpose: "script.fit",
      system: SCRIPT_SYSTEM,
      prompt: buildFitPrompt(ctx, draft),
      schema: scriptDraftSchema,
      effort: "medium",
      signal,
    });
    addTo(usage, fitted.usage);
    const candidate = normaliseDraft(fitted.data);
    if (lengthGap(candidate, ctx) < lengthGap(draft, ctx)) draft = candidate;
  }
  return { draft, usage };
}

function addTo(total: AIUsage, add: AIUsage): void {
  total.inputTokens += add.inputTokens;
  total.outputTokens += add.outputTokens;
  total.webSearches += add.webSearches;
  total.costUsd += add.costUsd;
}

/** Small-model drafting: exact sentence counts per section, re-planned until the length fits. */
async function draftWithSentencePlan(
  ai: AIProvider,
  ctx: ScriptContext,
  revision: { previous: string; issues: string[] } | undefined,
  signal?: AbortSignal,
): Promise<{ draft: ScriptDraft; usage: AIUsage }> {
  let plan = planFor(ctx);
  const rules = "Fill every sentence slot with one complete spoken sentence. Do not leave any slot short or empty.";
  const first = await ai.generateStructured({
    purpose: revision ? "script.revise" : "script.generate",
    system: SCRIPT_SYSTEM,
    prompt: `${buildScriptPrompt(ctx, revision)}\n${rules}`,
    schema: sentenceSchema(plan),
    effort: "high",
    signal,
  });
  const usage = { ...first.usage };
  let draft = normaliseDraft(draftFromSentences(first.data));
  let latest = draft;
  for (let pass = 0; pass < MAX_FIT_PASSES; pass++) {
    if (!needsLengthFit(draft, ctx)) break;
    // Learn the sentence length from the model's latest output, even if it was not kept.
    plan = replan(ctx, latest);
    const words = scriptWordBudget(ctx);
    const fitted = await ai.generateStructured({
      purpose: "script.fit",
      system: SCRIPT_SYSTEM,
      prompt: [
        `Rewrite this YouTube Short script about "${ctx.topicTitle}" so it has ${words.min}-${words.max} words in total (it has ${countWords(fullText(draft))}).`,
        "Use exactly the number of sentences given for each section below. Keep the one fact, the hook and the closing question; add concrete detail where more words are needed.",
        describePlan(plan),
        rules,
        "",
        ...researchLines(ctx),
        "",
        "Current script:",
        ...draft.sections.map((s) => `${s.type}: ${s.text}`),
      ].join("\n"),
      schema: sentenceSchema(plan),
      effort: "medium",
      signal,
    });
    addTo(usage, fitted.usage);
    latest = normaliseDraft(draftFromSentences(fitted.data));
    if (lengthGap(latest, ctx) < lengthGap(draft, ctx)) draft = latest;
  }
  return { draft, usage };
}

const FORMATTING_PATTERNS: [RegExp, string][] = [
  [/\[[^\]]*\]|\([^)]*(music|pause|sfx|sound|laugh)[^)]*\)/i, "contains stage directions"],
  [/\*[^*]+\*/, "contains markdown emphasis or actions"],
  [/https?:\/\//i, "contains a URL"],
  [/#\w+/, "contains hashtags"],
  [/\p{Extended_Pictographic}/u, "contains emojis"],
  [/^\s*(narrator|host|voice ?over)\s*:/im, "contains speaker labels"],
  [/\b(lorem ipsum|TODO|insert\s+\w+\s+here|\{\{)/i, "contains placeholder text"],
];

/** Intros the first sentence must not start with: the fact comes first. */
const INTRO_OPENERS = /^(did you know|here'?s|here is|fun fact|a fun fact|interesting fact|today\b|nowadays|these days|have you ever|ever wondered|imagine|let me tell you|in this video|welcome)/i;
/** Signs that a script lists several facts instead of one. */
const LIST_PATTERNS = /\b(number (one|two|three|four|five)|fact (number|no\.?|#) ?\d|another fact|next fact|second fact|(three|four|five|six|seven|eight|nine|ten|\d+) (facts|things|reasons|secrets)\b|firstly|secondly)/i;

/** Deterministic checks that do not need an AI call. */
export function programmaticChecks(
  draft: ScriptDraft,
  ctx: Pick<ScriptContext, "targetDurationSec" | "wordsPerMinute" | "tolerancePct" | "recentHooks" | "allowShorter">,
): ScriptValidation {
  const text = fullText(draft);
  const issues: ValidationIssue[] = [];
  const wordCount = countWords(text);
  const estimated = estimateSpeechDurationSec(text, ctx.wordsPerMinute);
  const sentences = sentencesOf(text);
  const firstSentence = sentences[0] ?? "";
  const lastSentence = sentences.at(-1) ?? "";
  const hookWords = countWords(firstSentence);
  const repetition = internalRepetition(text);
  const language = analyzeLanguage(text, "script");
  const budget = scriptWordBudget(ctx);

  if (!language.isEnglish) {
    issues.push({ check: "english", severity: "error", message: `Script is not English: ${language.reasons.join("; ")}` });
  }
  if (wordCount < budget.min || wordCount > budget.max) {
    const acceptablyShort = ctx.allowShorter && wordCount < budget.min && wordCount >= MIN_ACCEPTABLE_WORDS;
    issues.push({
      check: "duration",
      severity: acceptablyShort ? "warning" : "error",
      message: `Script has ${wordCount} words (~${estimated.toFixed(1)}s); it must have ${budget.min}-${budget.max} words`,
    });
  }
  if (!firstSentence) {
    issues.push({ check: "hook", severity: "error", message: "Script has no hook" });
  } else {
    if (hookWords > MAX_HOOK_WORDS) {
      issues.push({ check: "hook", severity: "error", message: `The first sentence is ${hookWords} words; it must state the fact in max ${MAX_HOOK_WORDS} words` });
    }
    if (/\?$/.test(firstSentence)) issues.push({ check: "hook", severity: "error", message: "The first sentence must state the fact, not ask a question" });
    const intro = INTRO_OPENERS.exec(firstSentence);
    if (intro) issues.push({ check: "hook", severity: "error", message: `The first sentence opens with an intro ("${intro[0]}"); state the fact directly` });
  }
  if (LIST_PATTERNS.test(text)) {
    issues.push({ check: "single_fact", severity: "error", message: "Script lists several facts; build it around exactly one fact" });
  }
  if (!draft.sections.some((s) => s.type === "INFORMATION" && s.text.trim())) {
    issues.push({ check: "structure", severity: "error", message: "Script does not explain why the fact is true" });
  }
  if (sentences.length < 2 || !/\?$/.test(lastSentence)) {
    issues.push({ check: "conclusion", severity: "error", message: "The last sentence must be a question for the viewer" });
  }
  if (repetition > 0.08) issues.push({ check: "repetition", severity: "error", message: `Script repeats itself (${Math.round(repetition * 100)}% repeated phrases)` });
  const longSentences = sentences.filter((s) => countWords(s) > 24);
  if (longSentences.length > 0) {
    issues.push({ check: "pacing", severity: "error", message: `${longSentences.length} sentence(s) are too long for Shorts narration (max 24 words)` });
  }
  const starts = sentences.map((s) => s.split(/\s+/).slice(0, 2).join(" ").toLowerCase());
  const repeatedStarts = starts.filter((s, i) => starts.indexOf(s) !== i).length;
  if (repeatedStarts > Math.max(2, sentences.length * 0.3)) {
    issues.push({ check: "repetition", severity: "warning", message: "Many sentences start the same way" });
  }
  for (const [pattern, message] of FORMATTING_PATTERNS) {
    if (pattern.test(text)) issues.push({ check: "formatting", severity: "error", message: `Script ${message}` });
  }
  const policy = checkContentPolicy(text);
  if (!policy.allowed) issues.push({ check: "policy", severity: "error", message: `Content policy: ${policy.categories.join(", ")}` });
  const reusedHook = firstSentence ? ctx.recentHooks.find((h) => similarity(h, firstSentence) > 0.7) : undefined;
  if (reusedHook) issues.push({ check: "hook", severity: "error", message: `Hook is too similar to a recent hook: "${reusedHook}"` });

  return {
    passed: !issues.some((i) => i.severity === "error"),
    issues,
    metrics: {
      wordCount,
      estimatedDurationSec: estimated,
      targetDurationSec: ctx.targetDurationSec,
      hookWords,
      repetition: Number(repetition.toFixed(3)),
      englishConfidence: language.confidence,
    },
  };
}

export async function reviewScript(
  ai: AIProvider,
  text: string,
  ctx: ScriptContext,
  signal?: AbortSignal,
): Promise<{ review: ScriptReview; usage: AIUsage }> {
  const result = await ai.generateStructured({
    purpose: "script.review",
    system: REVIEW_SYSTEM,
    prompt: [
      `Topic: ${ctx.topicTitle}`,
      "Research facts:",
      ...(ctx.research.facts.length ? ctx.research.facts.map((f) => `- ${f}`) : ["- (none)"]),
      ctx.research.uncertain.length ? `Uncertain points:\n- ${ctx.research.uncertain.join("\n- ")}` : "",
      "",
      `Script:\n"""${text}"""`,
      "",
      "The script must follow the one-fact format: exactly one fact for the whole video; the first sentence states that fact",
      "(no intro, not a question); then a surprising detail; then 2-3 short sentences explaining why; and a closing question for viewers.",
      "Review grammar and spelling, factual consistency with the research, unsupported claims, inappropriate content, whether the hook",
      "is misleading, whether the script uses exactly one fact and whether the first sentence states it. Score the hook, the closing",
      "question (conclusionScore) and overall suitability for YouTube Shorts (0-10).",
    ]
      .filter(Boolean)
      .join("\n"),
    schema: scriptReviewSchema,
    effort: "medium",
    signal,
  });
  return { review: result.data, usage: result.usage };
}

/**
 * Turns the AI review into QC issues. With `lenient` (a small local reviewer, whose
 * judgements are noisy) the format and taste judgements - single fact, hook, clickbait,
 * closing question and suitability - are warnings; facts, grammar and policy always block.
 */
export function reviewIssues(review: ScriptReview, hasResearch: boolean, lenient = false): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const taste: ValidationIssue["severity"] = lenient ? "warning" : "error";
  if (!review.grammarAndSpellingOk) issues.push({ check: "grammar", severity: "error", message: "Grammar or spelling problems" });
  if (hasResearch && !review.factuallyConsistent) issues.push({ check: "facts", severity: "error", message: "Script is not consistent with the research" });
  for (const claim of review.unsupportedClaims.slice(0, 5)) {
    issues.push({ check: "facts", severity: hasResearch ? "error" : "warning", message: `Unsupported claim: ${claim}` });
  }
  if (review.inappropriateContent) issues.push({ check: "policy", severity: "error", message: "Inappropriate content" });
  if (!review.singleFact) issues.push({ check: "single_fact", severity: taste, message: "Script is not built around exactly one fact" });
  if (!review.hookStatesFact) issues.push({ check: "hook", severity: taste, message: "The first sentence does not state the fact" });
  if (review.misleadingHook) issues.push({ check: "hook", severity: taste, message: "Hook is misleading clickbait" });
  if (review.hookScore < 6) issues.push({ check: "hook", severity: taste, message: `Weak hook (${review.hookScore}/10)` });
  if (review.conclusionScore < 5) issues.push({ check: "conclusion", severity: taste, message: `Weak closing question (${review.conclusionScore}/10)` });
  if (review.shortsSuitabilityScore < 6) issues.push({ check: "suitability", severity: taste, message: `Not well suited to Shorts (${review.shortsSuitabilityScore}/10)` });
  for (const issue of review.issues.slice(0, 5)) issues.push({ check: "review", severity: "warning", message: issue });
  return issues;
}

/** Full validation: programmatic checks, then (only if those pass) the AI review. */
export async function validateDraft(
  ai: AIProvider,
  draft: ScriptDraft,
  ctx: ScriptContext,
  signal?: AbortSignal,
): Promise<{ validation: ScriptValidation; usage?: AIUsage }> {
  const validation = programmaticChecks(draft, ctx);
  if (!validation.passed) return { validation };
  const { review, usage } = await reviewScript(ai, fullText(draft), ctx, signal);
  const issues = [...validation.issues, ...reviewIssues(review, ctx.research.facts.length > 0, Boolean(ai.prefersSimpleOutput))];
  return {
    validation: { ...validation, issues, review, passed: !issues.some((i) => i.severity === "error") },
    usage,
  };
}

export async function saveScriptVersion(opts: {
  videoId: string;
  draft: ScriptDraft;
  source: "AI" | "AI_REVISION" | "MANUAL";
  targetDurationSec: number;
  wordsPerMinute: number;
  validation?: ScriptValidation;
  aiModel?: string;
}): Promise<ScriptVersion> {
  const text = fullText(opts.draft);
  const hook = opts.draft.sections.find((s) => s.type === "HOOK")?.text ?? opts.draft.sections[0]?.text ?? "";
  return db.$transaction(async (tx) => {
    const script = await tx.script.upsert({
      where: { videoId: opts.videoId },
      create: { videoId: opts.videoId },
      update: {},
    });
    const last = await tx.scriptVersion.findFirst({ where: { scriptId: script.id }, orderBy: { version: "desc" } });
    const version = await tx.scriptVersion.create({
      data: {
        scriptId: script.id,
        version: (last?.version ?? 0) + 1,
        source: opts.source,
        status: opts.validation ? (opts.validation.passed ? "VALID" : "INVALID") : "DRAFT",
        hookStyle: opts.draft.hookStyle,
        hook,
        fullText: text,
        sections: opts.draft.sections as unknown as Prisma.InputJsonValue,
        wordCount: countWords(text),
        estimatedDurationSec: estimateSpeechDurationSec(text, opts.wordsPerMinute),
        targetDurationSec: opts.targetDurationSec,
        wordsPerMinute: opts.wordsPerMinute,
        validation: opts.validation ? (opts.validation as unknown as Prisma.InputJsonValue) : undefined,
        aiModel: opts.aiModel,
      },
    });
    await tx.script.update({ where: { id: script.id }, data: { currentVersionId: version.id } });
    return version;
  });
}

export async function updateVersionValidation(versionId: string, validation: ScriptValidation): Promise<ScriptVersion> {
  return db.scriptVersion.update({
    where: { id: versionId },
    data: {
      status: validation.passed ? "VALID" : "INVALID",
      validation: validation as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function currentScriptVersion(videoId: string): Promise<ScriptVersion> {
  const script = await db.script.findUnique({ where: { videoId }, include: { currentVersion: true } });
  if (!script?.currentVersion) throw new NotFoundError("Script for video", videoId);
  return script.currentVersion;
}

export function draftFromVersion(version: ScriptVersion): ScriptDraft {
  return {
    hookStyle: (version.hookStyle ?? "curiosity") as ScriptDraft["hookStyle"],
    sections: version.sections as unknown as ScriptDraft["sections"],
    factsUsed: [],
  };
}

/** Manual edit: split user text into sections (first sentence = hook) and store a new version. */
export function draftFromManualText(text: string): ScriptDraft {
  const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const [hook = "", ...rest] = sentences;
  const sections: ScriptDraft["sections"] = [{ type: "HOOK", text: hook }];
  if (rest.length > 1) sections.push({ type: "INFORMATION", text: rest.slice(0, -1).join(" ") });
  if (rest.length > 0) sections.push({ type: "PAYOFF", text: rest.at(-1)! });
  return { hookStyle: "curiosity", sections, factsUsed: [] };
}

export async function recentHooks(userId: string, limit = 20): Promise<string[]> {
  const versions = await db.scriptVersion.findMany({
    where: { script: { video: { userId } }, status: "VALID" },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { hook: true },
  });
  return versions.map((v) => v.hook);
}
