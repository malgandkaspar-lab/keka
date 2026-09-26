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

function buildScriptPrompt(ctx: ScriptContext, revision?: { previous: string; issues: string[] }): string {
  const words = targetWordCount(ctx.targetDurationSec, ctx.wordsPerMinute);
  const lines = [
    `Write a ${ctx.targetDurationSec}-second YouTube Short narration script.`,
    `Topic: ${ctx.topicTitle}`,
    ctx.topicAngle ? `Angle: ${ctx.topicAngle}` : "",
    `Category: ${ctx.categoryName}`,
    `Tone: ${ctx.tone}. ${describePacing(ctx.pacing)}`,
    `LENGTH IS CRITICAL: the narration is read at about ${ctx.wordsPerMinute} words per minute, so the whole script must be ${words.min}-${words.max} words (aim for ${words.target}). Count carefully.`,
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

export async function draftScript(
  ai: AIProvider,
  ctx: ScriptContext,
  revision?: { previous: string; issues: string[] },
  signal?: AbortSignal,
): Promise<{ draft: ScriptDraft; usage: AIUsage }> {
  const result = await ai.generateStructured({
    purpose: revision ? "script.revise" : "script.generate",
    system: SCRIPT_SYSTEM,
    prompt: buildScriptPrompt(ctx, revision),
    schema: scriptDraftSchema,
    effort: "high",
    signal,
  });
  const draft = result.data;
  // Normalise: the first section must be the hook.
  if (draft.sections[0]?.type !== "HOOK" && draft.sections[0]) draft.sections[0] = { ...draft.sections[0], type: "HOOK" };
  return { draft, usage: result.usage };
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
export function programmaticChecks(draft: ScriptDraft, ctx: Pick<ScriptContext, "targetDurationSec" | "wordsPerMinute" | "tolerancePct" | "recentHooks">): ScriptValidation {
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
    issues.push({
      check: "duration",
      severity: "error",
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
