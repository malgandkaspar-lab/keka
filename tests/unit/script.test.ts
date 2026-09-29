import { describe, expect, it } from "vitest";
import { z } from "zod";
import { countSpokenWords, estimateSpeechDurationSec, isWithinDuration, targetWordCount } from "@/services/scripts/duration";
import { draftFromManualText, draftScript, fullText, programmaticChecks, reviewIssues, type ScriptContext, type ScriptDraft, type ScriptReview } from "@/services/scripts/script-service";
import { ASTRONAUT_SCRIPT, FakeAIProvider } from "../helpers/fakes";
import { impliedWordsPerMinute } from "@/services/tts/speech-rate";

const ctx = { targetDurationSec: 30, wordsPerMinute: 165, tolerancePct: 0.12, recentHooks: [] as string[] };

describe("speech duration", () => {
  it("counts numbers as their spoken length", () => {
    expect(countSpokenWords("In 1969 we went")).toBe(7);
    expect(countSpokenWords("It weighs 12 tons")).toBe(4);
  });

  it("estimates duration from words per minute plus pauses", () => {
    const text = Array.from({ length: 165 }, () => "word").join(" ");
    expect(estimateSpeechDurationSec(text, 165)).toBeCloseTo(60, 0);
    expect(estimateSpeechDurationSec("One. Two. Three.", 165)).toBeGreaterThan(estimateSpeechDurationSec("One two three", 165));
  });

  it("derives a word budget that fits the target duration", () => {
    const budget = targetWordCount(60, 165);
    expect(budget.target).toBeLessThan(165);
    expect(budget.min).toBeLessThan(budget.target);
    expect(budget.max).toBeGreaterThan(budget.target);
    expect(isWithinDuration(64, 60, 0.1)).toBe(true);
    expect(isWithinDuration(90, 60, 0.1)).toBe(false);
  });
});

describe("script quality control (programmatic)", () => {
  const withSections = (sections: ScriptDraft["sections"]): ScriptDraft => ({ ...ASTRONAUT_SCRIPT, sections });
  const [hook, detail, why, question] = ASTRONAUT_SCRIPT.sections as unknown as ScriptDraft["sections"];
  const checksOf = (draft: ScriptDraft, extra: Partial<typeof ctx> = {}) => new Set(programmaticChecks(draft, { ...ctx, ...extra }).issues.filter((i) => i.severity === "error").map((i) => i.check));

  it("passes a well-formed one-fact script (fact first, detail, why, closing question, 60-90 words)", () => {
    const result = programmaticChecks(ASTRONAUT_SCRIPT, ctx);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.metrics.hookWords).toBeLessThanOrEqual(12);
    expect(result.metrics.wordCount).toBeGreaterThanOrEqual(60);
    expect(result.metrics.wordCount).toBeLessThanOrEqual(90);
  });

  it("enforces 60-90 words", () => {
    const long = withSections([hook!, detail!, { type: "INFORMATION", text: Array.from({ length: 8 }, () => "Gravity pulls the discs of your spine together all day long.").join(" ") }, question!]);
    expect(checksOf(long)).toContain("duration");
    expect(checksOf(withSections([hook!, question!]))).toContain("duration");
  });

  it("requires the fact itself in a short first sentence - no intro, no question", () => {
    expect(checksOf(withSections([{ type: "HOOK", text: "Did you know astronauts come home taller?" }, detail!, why!, question!]))).toContain("hook");
    expect(checksOf(withSections([{ type: "HOOK", text: "Here's a fun fact: astronauts come home taller." }, detail!, why!, question!]))).toContain("hook");
    expect(checksOf(withSections([{ type: "HOOK", text: "Nowadays astronauts come home taller." }, detail!, why!, question!]))).toContain("hook");
    expect(
      checksOf(withSections([{ type: "HOOK", text: "Astronauts who spend many months on the space station come home up to two inches taller." }, detail!, why!, question!])),
    ).toContain("hook");
  });

  it("rejects lists of facts and a missing closing question or explanation", () => {
    expect(checksOf(withSections([hook!, { type: "CURIOSITY", text: "Here are five facts about the spine you never knew." }, why!, question!]))).toContain("single_fact");
    expect(checksOf(withSections([hook!, detail!, why!, { type: "CTA", text: "Follow for more space facts." }]))).toContain("conclusion");
    expect(checksOf(withSections([hook!, detail!, question!]))).toContain("structure");
  });

  it("rejects non-English text and stage directions", () => {
    const bad: ScriptDraft = {
      hookStyle: "question",
      sections: [
        { type: "HOOK", text: "[dramatic music] Astronauten werden im Weltraum größer." },
        { type: "INFORMATION", text: "Die Schwerkraft drückt die Bandscheiben zusammen, und im All fehlt dieser Druck völlig." },
      ],
      factsUsed: [],
    };
    const checks = checksOf(bad);
    expect(checks.has("english")).toBe(true);
    expect(checks.has("formatting")).toBe(true);
    expect(checks.has("conclusion")).toBe(true);
  });

  it("rejects repeated hooks and internal repetition", () => {
    expect(checksOf(ASTRONAUT_SCRIPT, { recentHooks: ["Astronauts come home two inches taller."] })).toContain("hook");
    const repetitive = withSections(ASTRONAUT_SCRIPT.sections.map((s) => ({ ...s, text: "gravity squeezes the spine every day. gravity squeezes the spine every day." })));
    expect(programmaticChecks(repetitive, ctx).issues.some((i) => i.check === "repetition")).toBe(true);
  });

  it("accepts a somewhat shorter script only as a last resort", () => {
    const shorter = withSections([hook!, detail!, { type: "INFORMATION", text: "On Earth, gravity squeezes the soft discs between your vertebrae all day long. In orbit, that pressure simply disappears for months." }, question!]);
    const words = programmaticChecks(shorter, ctx).metrics.wordCount;
    expect(words).toBeGreaterThanOrEqual(50);
    expect(words).toBeLessThan(60);
    expect(programmaticChecks(shorter, ctx).passed).toBe(false);
    expect(programmaticChecks(shorter, { ...ctx, allowShorter: true }).passed).toBe(true);
    expect(programmaticChecks(withSections([hook!, question!]), { ...ctx, allowShorter: true }).passed).toBe(false);
  });

  const review: ScriptReview = { grammarAndSpellingOk: true, factuallyConsistent: true, unsupportedClaims: [], inappropriateContent: false, misleadingHook: false, singleFact: true, hookStatesFact: true, hookScore: 8, conclusionScore: 8, shortsSuitabilityScore: 8, issues: [] };

  it("turns AI review findings into blocking issues", () => {
    const issues = reviewIssues({ ...review, factuallyConsistent: false, unsupportedClaims: ["Astronauts grow a foot"], misleadingHook: true, hookScore: 4, singleFact: false }, true);
    expect(issues.filter((i) => i.severity === "error").map((i) => i.check)).toEqual(expect.arrayContaining(["facts", "hook", "single_fact"]));
  });

  it("treats a small local reviewer's format and taste judgements as warnings, but never factual problems", () => {
    const noisy = { ...review, unsupportedClaims: ["Built over 2,000 years."], misleadingHook: true, hookScore: 3, singleFact: false, hookStatesFact: false };
    expect(reviewIssues(noisy, true).filter((i) => i.severity === "error").map((i) => i.check)).toEqual(["facts", "single_fact", "hook", "hook", "hook"]);
    expect(reviewIssues(noisy, true, true).filter((i) => i.severity === "error").map((i) => i.check)).toEqual(["facts"]);
  });

  it("splits manual text into hook, body and payoff", () => {
    const draft = draftFromManualText("Did you know this? First fact here. Second fact here. The final payoff.");
    expect(draft.sections[0]).toEqual({ type: "HOOK", text: "Did you know this?" });
    expect(draft.sections.at(-1)!.type).toBe("PAYOFF");
    expect(fullText(draft)).toBe("Did you know this? First fact here. Second fact here. The final payoff.");
  });
});

describe("speaking-rate calibration", () => {
  it("recovers the words-per-minute that reproduces a measured duration", () => {
    const text = fullText(ASTRONAUT_SCRIPT);
    const wpm = impliedWordsPerMinute(text, 20.8)!;
    expect(wpm).toBeGreaterThan(190);
    expect(estimateSpeechDurationSec(text, wpm)).toBeCloseTo(20.6, 0);
    expect(impliedWordsPerMinute("Too short.", 3)).toBeNull();
  });
});

describe("script length fitting", () => {
  const scriptCtx: ScriptContext = {
    topicTitle: "Why do astronauts grow taller in space?",
    categoryName: "Space",
    research: { summary: null, facts: ["Astronauts can grow up to 3% taller in microgravity"], uncertain: [], cautions: [] },
    targetDurationSec: 30,
    wordsPerMinute: 165,
    tolerancePct: 0.12,
    pacing: "fast",
    tone: "curious",
    includeCta: true,
    recentHooks: [],
  };
  const tooShort: ScriptDraft = {
    hookStyle: "unexpected_fact",
    sections: [
      { type: "HOOK", text: "Astronauts come home taller." },
      { type: "CTA", text: "Would you want that?" },
    ],
    factsUsed: [],
  };

  it("lengthens a draft that is far too short before quality control", async () => {
    const ai = new FakeAIProvider();
    ai.overrides["script.generate"] = () => tooShort;
    const prompts: string[] = [];
    ai.overrides["script.fit"] = (request) => (prompts.push(request.prompt), ASTRONAUT_SCRIPT);
    const { draft } = await draftScript(ai, scriptCtx);
    expect(ai.calls["script.fit"]).toBe(1);
    expect(prompts[0]).toMatch(/Make it LONGER/);
    expect(programmaticChecks(draft, scriptCtx).passed).toBe(true);
  });

  it("keeps the closest draft when fitting does not help, and skips fitting when the length is right", async () => {
    const ai = new FakeAIProvider();
    ai.overrides["script.generate"] = () => tooShort;
    ai.overrides["script.fit"] = () => ({ ...tooShort, sections: [tooShort.sections[0]!] });
    const { draft } = await draftScript(ai, scriptCtx);
    expect(ai.calls["script.fit"]).toBe(2);
    expect(fullText(draft)).toBe(fullText(tooShort));

    const good = new FakeAIProvider();
    await draftScript(good, scriptCtx);
    expect(good.calls["script.fit"]).toBeUndefined();
  });

  it("asks for the one-fact format with a per-section sentence plan", async () => {
    const ai = new FakeAIProvider();
    let prompt = "";
    ai.overrides["script.generate"] = (request) => ((prompt = request.prompt), ASTRONAUT_SCRIPT);
    await draftScript(ai, scriptCtx);
    expect(prompt).toMatch(/ONE fact for the whole video/);
    expect(prompt).toMatch(/60-90 words/);
    expect(prompt).toMatch(/INFORMATION: [23] sentences/);
  });
});

describe("script drafting with a small local model", () => {
  const scriptCtx: ScriptContext = {
    topicTitle: "5 facts about the Great Wall of China",
    categoryName: "History",
    research: { summary: null, facts: ["The Ming dynasty built the best-known sections between 1368 and 1644"], uncertain: [], cautions: [] },
    targetDurationSec: 30,
    wordsPerMinute: 210,
    tolerancePct: 0.12,
    pacing: "fast",
    tone: "curious",
    includeCta: true,
    recentHooks: [],
  };
  type Props = Record<string, { minItems?: number }>;
  const slots = (request: { schema: z.ZodType }) => (z.toJSONSchema(request.schema) as { properties: Props }).properties.why!.minItems!;
  const answer = (request: { schema: z.ZodType }, why: string) => ({
    hookStyle: "unexpected_fact",
    hook: "The Great Wall is not one single wall.",
    detail: "It is thousands of separate walls built over many centuries.",
    why: why.split("|").slice(0, slots(request)),
    question: "Would you walk the whole thing?",
    factsUsed: [],
  });

  it("asks for an exact number of 'why' sentences and re-plans when they come out short", async () => {
    const ai = Object.assign(new FakeAIProvider(), { prefersSimpleOutput: true });
    const counts: number[] = [];
    ai.overrides["script.generate"] = (request) => (counts.push(slots(request)), answer(request, "Dynasties built walls.|Raiders came from the north.|Some parts are dirt."));
    ai.overrides["script.fit"] = (request) => (
      counts.push(slots(request)),
      answer(
        request,
        "Different Chinese dynasties kept building new walls to protect their northern borders.|Nomadic horse riders could raid farms quickly, so every ruler wanted a barrier.|Later builders connected some sections, but many older walls were simply abandoned.",
      )
    );
    const { draft } = await draftScript(ai, scriptCtx);
    expect(ai.calls["script.fit"]).toBeGreaterThanOrEqual(1);
    expect(counts.every((n) => n >= 2 && n <= 3)).toBe(true);
    expect(draft.sections.map((s) => s.type)).toEqual(["HOOK", "CURIOSITY", "INFORMATION", "CTA"]);
    expect(programmaticChecks(draft, scriptCtx).issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});
