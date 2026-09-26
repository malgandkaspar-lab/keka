import { z } from "zod";
import type { Prisma, ScriptVersion } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import type { AIProvider, AIUsage } from "@/services/ai/types";
import { internalRepetition, similarity } from "@/services/dedup/similarity";
import { analyzeLanguage } from "@/services/language/language-service";
import { checkContentPolicy, CONTENT_POLICY_PROMPT, ENGLISH_ONLY_PROMPT } from "@/services/policy/content-policy";
import { countWords, estimateSpeechDurationSec, isWithinDuration, targetWordCount } from "./duration";

/**
 * ScriptService
 *
 * Purpose: write, validate and revise narration scripts optimised for YouTube Shorts.
 *
 * Structure: HOOK -> CURIOSITY -> INFORMATION -> ESCALATION/SURPRISE -> PAYOFF -> optional
 * CTA, with deliberate variation in hooks, pacing and endings.
 * Duration: word budget derived from the target duration and English words-per-minute;
 * every version stores its estimated spoken duration.
 * Quality control: programmatic checks (English, length, pacing, repetition, hook,
 * conclusion, formatting, policy) plus an AI review (grammar, spelling, factual
 * consistency against research, unsupported claims, suitability). Failed scripts are
 * revised automatically until they pass or attempts run out.
 */
export const SECTION_TYPES = ["HOOK", "CURIOSITY", "INFORMATION", "ESCALATION", "PAYOFF", "CTA"] as const;
export const HOOK_STYLES = ["curiosity", "contrarian", "question", "unexpected_fact", "story", "challenge", "number"] as const;

export const scriptDraftSchema = z.object({
  hookStyle: z.enum(HOOK_STYLES),
  sections: z
    .array(
      z.object({
        type: z.enum(SECTION_TYPES),
        text: z.string().describe("Narration exactly as it will be spoken"),
      }),
    )
    .describe("Ordered sections; the first must be HOOK"),
  factsUsed: z.array(z.string()).describe("Which researched facts the script relies on"),
});
export type ScriptDraft = z.infer<typeof scriptDraftSchema>;

export const scriptReviewSchema = z.object({
  grammarAndSpellingOk: z.boolean(),
  factuallyConsistent: z.boolean().describe("Every claim is supported by the research facts"),
  unsupportedClaims: z.array(z.string()),
  inappropriateContent: z.boolean(),
  misleadingHook: z.boolean().describe("The hook overpromises or misrepresents the video"),
  hookScore: z.number().min(0).max(10),
  conclusionScore: z.number().min(0).max(10),
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
  /** Last resort: accept a script that is shorter than planned (but still a real Short) with a warning. */
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

const SCRIPT_SYSTEM = `You are an award-winning YouTube Shorts scriptwriter for an educational channel.
You write narration that is punchy, truthful and made to be listened to: short spoken sentences,
concrete numbers, vivid comparisons and no filler. You never use misleading clickbait: the hook must
accurately represent what the video delivers.
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

function describePacing(pacing: ScriptContext["pacing"]): string {
  switch (pacing) {
    case "fast":
      return "Fast pacing: very short sentences (4-10 words), rapid-fire reveals, a new idea every 2-3 seconds.";
    case "measured":
      return "Measured, cinematic pacing: vary sentence length, allow a few longer atmospheric sentences.";
    case "calm":
      return "Calm, clear pacing: conversational sentences, one idea at a time.";
  }
}

interface SentencePlan {
  curiosity: number;
  information: number;
  escalation: number;
  payoff: number;
  cta: boolean;
}

const HOOK_WORDS = 10;
const CTA_WORDS = 6;

function wordsPerSentence(ctx: Pick<ScriptContext, "pacing">): number {
  return ctx.pacing === "fast" ? 9 : 12;
}

/** Splits a number of body sentences over the sections. */
function distributeSentences(body: number, cta: boolean): SentencePlan {
  const total = Math.max(4, Math.min(24, Math.round(body)));
  const curiosity = Math.max(1, Math.round(total * 0.2));
  const escalation = Math.max(1, Math.round(total * 0.25));
  const payoff = Math.max(1, Math.round(total * 0.2));
  return { curiosity, information: Math.max(1, total - curiosity - escalation - payoff), escalation, payoff, cta };
}

function planFor(ctx: ScriptContext): SentencePlan {
  const words = targetWordCount(ctx.targetDurationSec, ctx.wordsPerMinute).target;
  return distributeSentences((words - HOOK_WORDS - (ctx.includeCta ? CTA_WORDS : 0)) / wordsPerSentence(ctx), ctx.includeCta);
}

/** Sentence plan per section: small models follow sentence counts far better than word counts. */
function describePlan(plan: SentencePlan, perSentence: number): string {
  return [
    `Section plan (about ${perSentence} words per sentence):`,
    "- HOOK: 1 sentence, max 12 words",
    `- CURIOSITY: ${plan.curiosity} sentence(s)`,
    `- INFORMATION: ${plan.information} sentences`,
    `- ESCALATION: ${plan.escalation} sentence(s)`,
    `- PAYOFF: ${plan.payoff} sentence(s)`,
    plan.cta ? "- CTA: 1 short sentence" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function sectionPlan(ctx: ScriptContext): string {
  return describePlan(planFor(ctx), wordsPerSentence(ctx));
}

/**
 * Output schema with an exact sentence count per section. Local models decode with a
 * JSON grammar, so fixed-length arrays make the length of the script reliable.
 */
function sentenceSchema(plan: SentencePlan) {
  const sentences = (count: number) => z.array(z.string().describe("One spoken sentence of 8-14 words")).length(count);
  return z.object({
    hookStyle: z.enum(HOOK_STYLES),
    hook: z.string().describe("One hook sentence, max 12 words"),
    curiosity: sentences(plan.curiosity),
    information: sentences(plan.information),
    escalation: sentences(plan.escalation),
    payoff: sentences(plan.payoff),
    cta: plan.cta ? z.string().describe("One short call to action") : z.string().optional(),
    factsUsed: z.array(z.string()),
  });
}

type SentenceDraft = z.infer<ReturnType<typeof sentenceSchema>>;

function draftFromSentences(data: SentenceDraft, plan: SentencePlan): ScriptDraft {
  const join = (parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).join(" ");
  const sections: ScriptDraft["sections"] = [
    { type: "HOOK", text: data.hook.trim() },
    { type: "CURIOSITY", text: join(data.curiosity) },
    { type: "INFORMATION", text: join(data.information) },
    { type: "ESCALATION", text: join(data.escalation) },
    { type: "PAYOFF", text: join(data.payoff) },
  ];
  if (plan.cta && data.cta?.trim()) sections.push({ type: "CTA", text: data.cta.trim() });
  return { hookStyle: data.hookStyle, sections: sections.filter((section) => section.text), factsUsed: data.factsUsed };
}

/** Re-plans the sentence count from the words per sentence the model actually writes. */
function replan(ctx: ScriptContext, draft: ScriptDraft): SentencePlan {
  const body = draft.sections.filter((s) => s.type !== "HOOK" && s.type !== "CTA");
  const bodyText = body.map((s) => s.text).join(" ");
  const sentences = Math.max(1, bodyText.split(/(?<=[.!?])\s+/).filter(Boolean).length);
  const perSentence = Math.max(5, countWords(bodyText) / sentences);
  const words = targetWordCount(ctx.targetDurationSec, ctx.wordsPerMinute).target;
  return distributeSentences((words - HOOK_WORDS - (ctx.includeCta ? CTA_WORDS : 0)) / perSentence, ctx.includeCta);
}

function buildScriptPrompt(ctx: ScriptContext, revision?: { previous: string; issues: string[] }): string {
  const words = targetWordCount(ctx.targetDurationSec, ctx.wordsPerMinute);
  const lines = [
    `Write a ${ctx.targetDurationSec}-second YouTube Short narration script.`,
    `Topic: ${ctx.topicTitle}`,
    ctx.topicAngle ? `Angle: ${ctx.topicAngle}` : "",
    `Category: ${ctx.categoryName}`,
    `Tone: ${ctx.tone}. ${describePacing(ctx.pacing)}`,
    `LENGTH IS CRITICAL: the narration is read at about ${ctx.wordsPerMinute} words per minute, so the whole script must be ${words.min}-${words.max} words (aim for ${words.target}). Count carefully.`,
    sectionPlan(ctx),
    "Structure (adapt it, do not make it mechanical): HOOK (first 1-3 seconds, max 12 words) -> CURIOSITY -> INFORMATION -> ESCALATION or SURPRISE -> PAYOFF" +
      (ctx.includeCta ? " -> a short, natural CTA (max 8 words)." : ". Do not add a CTA."),
    "Hook styles you may choose from: curiosity, contrarian fact, question, unexpected fact, story, challenge, number.",
    ctx.preferredHookStyles?.length ? `Hook styles that have performed well: ${ctx.preferredHookStyles.join(", ")}.` : "",
    ctx.recentHooks.length ? `Avoid reusing these recent hooks or their wording:\n- ${ctx.recentHooks.slice(0, 15).join("\n- ")}` : "",
    "End with a satisfying payoff, not a cliffhanger or a question left unanswered.",
    "",
    "Research you may rely on (use ONLY these facts; do not add facts from memory):",
    ...(ctx.research.facts.length ? ctx.research.facts.map((f) => `- ${f}`) : ["- (no verified facts available: keep claims general and clearly hedged)"]),
    ctx.research.uncertain.length ? `Uncertain or speculative points (only mention with clear hedging such as "scientists think"):\n- ${ctx.research.uncertain.join("\n- ")}` : "",
    ctx.research.cautions.length ? `Misconceptions to avoid:\n- ${ctx.research.cautions.join("\n- ")}` : "",
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

/** How far a draft's estimated spoken duration is from the target, in seconds. */
/** Length fitting only makes sense for an English draft; anything else goes to QC and revision. */
function needsLengthFit(draft: ScriptDraft, ctx: ScriptContext): boolean {
  const text = fullText(draft);
  if (!analyzeLanguage(text, "script").isEnglish) return false;
  return !isWithinDuration(estimateSpeechDurationSec(text, ctx.wordsPerMinute), ctx.targetDurationSec, ctx.tolerancePct);
}

function durationGap(draft: ScriptDraft, ctx: ScriptContext): number {
  return Math.abs(estimateSpeechDurationSec(fullText(draft), ctx.wordsPerMinute) - ctx.targetDurationSec);
}

function buildFitPrompt(ctx: ScriptContext, draft: ScriptDraft): string {
  const words = targetWordCount(ctx.targetDurationSec, ctx.wordsPerMinute);
  const current = countWords(fullText(draft));
  const tooShort = current < words.target;
  const delta = Math.abs(words.target - current);
  const sentences = Math.max(1, Math.round(delta / (ctx.pacing === "fast" ? 9 : 12)));
  return [
    `This YouTube Short script about "${ctx.topicTitle}" has ${current} words, but it must have ${words.min}-${words.max} words (aim for ${words.target}).`,
    tooShort
      ? `Make it LONGER: add about ${delta} words (about ${sentences} more sentences). Keep the hook. Expand CURIOSITY, INFORMATION and ESCALATION with concrete details, numbers, comparisons and explanation of how and why. Every section except the hook should have at least 2 sentences.`
      : `Make it SHORTER: remove about ${delta} words (about ${sentences} sentences). Keep the hook and the payoff; cut the least important details.`,
    "Keep the same topic, facts and English style. Return the complete revised script.",
    sectionPlan(ctx),
    "",
    "Research you may rely on (use ONLY these facts; if there are few, explain the mechanism in more depth instead of inventing facts):",
    ...(ctx.research.facts.length ? ctx.research.facts.map((f) => `- ${f}`) : ["- (no verified facts available: keep claims general and clearly hedged)"]),
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
    if (durationGap(candidate, ctx) < durationGap(draft, ctx)) draft = candidate;
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
  const rules = "Fill every sentence slot with one complete spoken sentence of 8-14 words. Do not leave any slot short or empty.";
  const first = await ai.generateStructured({
    purpose: revision ? "script.revise" : "script.generate",
    system: SCRIPT_SYSTEM,
    prompt: `${buildScriptPrompt(ctx, revision)}\n${rules}`,
    schema: sentenceSchema(plan),
    effort: "high",
    signal,
  });
  const usage = { ...first.usage };
  let draft = normaliseDraft(draftFromSentences(first.data, plan));
  let latest = draft;
  for (let pass = 0; pass < MAX_FIT_PASSES; pass++) {
    if (!needsLengthFit(draft, ctx)) break;
    // Learn the sentence length from the model's latest output, even if it was not kept.
    plan = replan(ctx, latest);
    const words = targetWordCount(ctx.targetDurationSec, ctx.wordsPerMinute);
    const fitted = await ai.generateStructured({
      purpose: "script.fit",
      system: SCRIPT_SYSTEM,
      prompt: [
        `Rewrite this YouTube Short script about "${ctx.topicTitle}" so it has ${words.min}-${words.max} words in total (it has ${countWords(fullText(draft))}).`,
        "Use exactly the number of sentences given for each section below. Keep the hook, the facts and the payoff; add concrete detail where more sentences are needed.",
        describePlan(plan, wordsPerSentence(ctx)),
        rules,
        "",
        "Research you may rely on (use ONLY these facts):",
        ...(ctx.research.facts.length ? ctx.research.facts.map((f) => `- ${f}`) : ["- (no verified facts available: keep claims general and clearly hedged)"]),
        "",
        "Current script:",
        ...draft.sections.map((s) => `${s.type}: ${s.text}`),
      ].join("\n"),
      schema: sentenceSchema(plan),
      effort: "medium",
      signal,
    });
    addTo(usage, fitted.usage);
    latest = normaliseDraft(draftFromSentences(fitted.data, plan));
    if (durationGap(latest, ctx) < durationGap(draft, ctx)) draft = latest;
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

/** Deterministic checks that do not need an AI call. */
/** Shortest script accepted as a last resort (allowShorter). */
export function minimumAcceptableDurationSec(targetSec: number): number {
  return Math.max(15, targetSec * 0.6);
}

export function programmaticChecks(
  draft: ScriptDraft,
  ctx: Pick<ScriptContext, "targetDurationSec" | "wordsPerMinute" | "tolerancePct" | "recentHooks" | "allowShorter">,
): ScriptValidation {
  const text = fullText(draft);
  const issues: ValidationIssue[] = [];
  const wordCount = countWords(text);
  const estimated = estimateSpeechDurationSec(text, ctx.wordsPerMinute);
  const hook = draft.sections.find((s) => s.type === "HOOK")?.text ?? "";
  const hookWords = countWords(hook);
  const repetition = internalRepetition(text);
  const language = analyzeLanguage(text, "script");

  if (!language.isEnglish) {
    issues.push({ check: "english", severity: "error", message: `Script is not English: ${language.reasons.join("; ")}` });
  }
  if (!isWithinDuration(estimated, ctx.targetDurationSec, ctx.tolerancePct)) {
    const target = targetWordCount(ctx.targetDurationSec, ctx.wordsPerMinute);
    const acceptablyShort = ctx.allowShorter && estimated < ctx.targetDurationSec && estimated >= minimumAcceptableDurationSec(ctx.targetDurationSec);
    issues.push({
      check: "duration",
      severity: acceptablyShort ? "warning" : "error",
      message: `Estimated spoken duration is ${estimated.toFixed(1)}s but the target is ${ctx.targetDurationSec}s (${wordCount} words; use ${target.min}-${target.max} words)`,
    });
  }
  if (hookWords === 0) issues.push({ check: "hook", severity: "error", message: "Script has no hook" });
  else if (hookWords > 16) issues.push({ check: "hook", severity: "error", message: `Hook is ${hookWords} words; it must be speakable in under 3 seconds (max 12 words)` });
  const lastType = draft.sections.at(-1)?.type;
  const payoffPresent = draft.sections.some((s) => s.type === "PAYOFF");
  if (!payoffPresent) issues.push({ check: "conclusion", severity: "error", message: "Script has no payoff" });
  if (lastType && lastType !== "PAYOFF" && lastType !== "CTA") {
    issues.push({ check: "conclusion", severity: "warning", message: "Script does not end on its payoff" });
  }
  if (repetition > 0.08) issues.push({ check: "repetition", severity: "error", message: `Script repeats itself (${Math.round(repetition * 100)}% repeated phrases)` });
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const longSentences = sentences.filter((s) => countWords(s) > 28);
  if (longSentences.length > 0) {
    issues.push({ check: "pacing", severity: "error", message: `${longSentences.length} sentence(s) are too long for Shorts narration (max 28 words)` });
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
  const reusedHook = ctx.recentHooks.find((h) => similarity(h, hook) > 0.7);
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
      `Target duration: ${ctx.targetDurationSec} seconds`,
      "Research facts:",
      ...(ctx.research.facts.length ? ctx.research.facts.map((f) => `- ${f}`) : ["- (none)"]),
      ctx.research.uncertain.length ? `Uncertain points:\n- ${ctx.research.uncertain.join("\n- ")}` : "",
      "",
      `Script:\n"""${text}"""`,
      "",
      "Review grammar and spelling, factual consistency with the research, unsupported claims, inappropriate content,",
      "whether the hook is misleading, and score the hook, the conclusion and overall suitability for YouTube Shorts (0-10).",
    ]
      .filter(Boolean)
      .join("\n"),
    schema: scriptReviewSchema,
    effort: "medium",
    signal,
  });
  return { review: result.data, usage: result.usage };
}

export function reviewIssues(review: ScriptReview, hasResearch: boolean): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!review.grammarAndSpellingOk) issues.push({ check: "grammar", severity: "error", message: "Grammar or spelling problems" });
  if (hasResearch && !review.factuallyConsistent) issues.push({ check: "facts", severity: "error", message: "Script is not consistent with the research" });
  for (const claim of review.unsupportedClaims.slice(0, 5)) {
    issues.push({ check: "facts", severity: hasResearch ? "error" : "warning", message: `Unsupported claim: ${claim}` });
  }
  if (review.inappropriateContent) issues.push({ check: "policy", severity: "error", message: "Inappropriate content" });
  if (review.misleadingHook) issues.push({ check: "hook", severity: "error", message: "Hook is misleading clickbait" });
  if (review.hookScore < 6) issues.push({ check: "hook", severity: "error", message: `Weak hook (${review.hookScore}/10)` });
  if (review.conclusionScore < 5) issues.push({ check: "conclusion", severity: "error", message: `Weak conclusion (${review.conclusionScore}/10)` });
  if (review.shortsSuitabilityScore < 6) issues.push({ check: "suitability", severity: "error", message: `Not well suited to Shorts (${review.shortsSuitabilityScore}/10)` });
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
  const issues = [...validation.issues, ...reviewIssues(review, ctx.research.facts.length > 0)];
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
