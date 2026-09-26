import { describe, expect, it } from "vitest";
import { countSpokenWords, estimateSpeechDurationSec, isWithinDuration, targetWordCount } from "@/services/scripts/duration";
import { draftFromManualText, fullText, programmaticChecks, reviewIssues, type ScriptDraft } from "@/services/scripts/script-service";
import { ASTRONAUT_SCRIPT } from "../helpers/fakes";
import { impliedWordsPerMinute } from "@/services/tts/speech-rate";

const ctx = { targetDurationSec: 30, wordsPerMinute: 165, tolerancePct: 0.12, recentHooks: [] };

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
  it("passes a well-formed English Shorts script", () => {
    const result = programmaticChecks(ASTRONAUT_SCRIPT, ctx);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.metrics.hookWords).toBeLessThanOrEqual(12);
  });

  it("rejects a 60-second script that would take 90 seconds to speak", () => {
    const long: ScriptDraft = {
      ...ASTRONAUT_SCRIPT,
      sections: [
        ASTRONAUT_SCRIPT.sections[0]!,
        { type: "INFORMATION", text: Array.from({ length: 20 }, (_, i) => `Fact number ${i} is about the spine and how gravity changes it over time.`).join(" ") },
        ASTRONAUT_SCRIPT.sections[4]!,
      ],
    };
    const result = programmaticChecks(long, { ...ctx, targetDurationSec: 60 });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.check === "duration")).toBe(true);
  });

  it("rejects non-English text, stage directions and missing payoffs", () => {
    const bad: ScriptDraft = {
      hookStyle: "question",
      sections: [
        { type: "HOOK", text: "[dramatic music] Warum werden Astronauten im Weltraum größer?" },
        { type: "INFORMATION", text: "Die Schwerkraft drückt die Bandscheiben zusammen, und im All fehlt dieser Druck völlig." },
      ],
      factsUsed: [],
    };
    const result = programmaticChecks(bad, ctx);
    const checks = new Set(result.issues.map((i) => i.check));
    expect(checks.has("english")).toBe(true);
    expect(checks.has("formatting")).toBe(true);
    expect(checks.has("conclusion")).toBe(true);
  });

  it("rejects repeated hooks and internal repetition", () => {
    const result = programmaticChecks(ASTRONAUT_SCRIPT, { ...ctx, recentHooks: ["Why do astronauts come home taller?"] });
    expect(result.issues.some((i) => i.check === "hook")).toBe(true);
    const repetitive: ScriptDraft = {
      ...ASTRONAUT_SCRIPT,
      sections: ASTRONAUT_SCRIPT.sections.map((s) => ({ ...s, text: "gravity squeezes the spine every day. gravity squeezes the spine every day." })),
    };
    expect(programmaticChecks(repetitive, ctx).issues.some((i) => i.check === "repetition")).toBe(true);
  });

  it("turns AI review findings into blocking issues", () => {
    const issues = reviewIssues(
      { grammarAndSpellingOk: true, factuallyConsistent: false, unsupportedClaims: ["Astronauts grow a foot"], inappropriateContent: false, misleadingHook: true, hookScore: 4, conclusionScore: 8, shortsSuitabilityScore: 8, issues: [] },
      true,
    );
    expect(issues.filter((i) => i.severity === "error").map((i) => i.check)).toEqual(expect.arrayContaining(["facts", "hook"]));
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
