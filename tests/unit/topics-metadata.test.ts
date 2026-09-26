import { describe, expect, it } from "vitest";
import { evaluateCandidates, overallScore, type TopicCandidate } from "@/services/topics/topic-service";
import { checkMetadata, composeDescription, normalizeHashtag, sanitizeMetadata } from "@/services/metadata/metadata-service";
import { internalRepetition, similarity } from "@/services/dedup/similarity";
import { checkContentPolicy } from "@/services/policy/content-policy";
import { assessSufficiency, isGroundedIn } from "@/services/research/research-service";
import { sourceReliability } from "@/services/research/source-reliability";

const scores = { curiosity: 9, novelty: 8, educationalValue: 9, entertainment: 8, visualPotential: 8, shortFormPotential: 9, factualVerifiability: 9 };
const candidate = (title: string, overrides: Partial<TopicCandidate> = {}): TopicCandidate => ({ title, angle: "angle", scores, visualIdeas: [], ...overrides });

describe("topic engine", () => {
  it("weights the seven quality criteria", () => {
    expect(overallScore(scores)).toBeGreaterThan(8);
    expect(overallScore({ ...scores, factualVerifiability: 0, curiosity: 0 })).toBeLessThan(overallScore(scores));
  });

  it("filters duplicates, low scores, unverifiable and non-English candidates", () => {
    const verdicts = evaluateCandidates(
      [
        candidate("Why do astronauts grow taller in space?"),
        candidate("Why astronauts grow taller in space"),
        candidate("Why do octopuses have three hearts?"),
        candidate("Miks kaheksajalal on kolm südant?"),
        candidate("A boring topic", { scores: { ...scores, curiosity: 1, novelty: 1, entertainment: 1, visualPotential: 1 } }),
        candidate("Aliens built the pyramids", { scores: { ...scores, factualVerifiability: 2 } }),
      ],
      ["Why do astronauts grow taller in space?"],
      6.5,
      0.55,
    );
    const accepted = verdicts.filter((v) => !v.reason).map((v) => v.candidate.title);
    expect(accepted).toEqual(["Why do octopuses have three hearts?"]);
  });

  it("detects similar topics and repetition", () => {
    expect(similarity("Why do astronauts grow taller in space?", "Why astronauts get taller in space")).toBeGreaterThan(0.5);
    expect(similarity("Why do astronauts grow taller in space?", "How do bees make honey?")).toBeLessThan(0.3);
    expect(internalRepetition("one two three four one two three four one two three four")).toBeGreaterThan(0.3);
  });
});

describe("content policy", () => {
  it("blocks dangerous and explicit requests but allows educational topics", () => {
    expect(checkContentPolicy("How to make a pipe bomb at home").allowed).toBe(false);
    expect(checkContentPolicy("How to synthesize meth step by step").allowed).toBe(false);
    expect(checkContentPolicy("Why do volcanoes explode?").allowed).toBe(true);
    expect(checkContentPolicy("The history of the atomic bomb").allowed).toBe(true);
  });
});

describe("research sufficiency", () => {
  it("requires several reliably sourced established facts", () => {
    const sources = [{ url: "https://www.nasa.gov/a", reliability: sourceReliability("https://www.nasa.gov/a") }, { url: "https://blog.example.com/x", reliability: sourceReliability("https://blog.example.com/x") }];
    const fact = (url: string) => ({ statement: "fact", type: "ESTABLISHED_FACT" as const, confidence: 0.9, sourceUrls: [url] });
    const base = { summary: "s", sufficient: true, recommendedAngle: "a", cautions: [] };
    expect(assessSufficiency({ ...base, claims: [fact("https://www.nasa.gov/a"), fact("https://www.nasa.gov/a"), fact("https://www.nasa.gov/a")] }, sources)).toBe(true);
    expect(assessSufficiency({ ...base, claims: [fact("https://blog.example.com/x"), fact("https://blog.example.com/x"), fact("https://blog.example.com/x")] }, sources)).toBe(false);
    expect(sourceReliability("https://www.reddit.com/r/space")).toBeLessThan(0.5);
    expect(sourceReliability("https://science.nasa.gov/x")).toBeGreaterThan(0.9);
  });
});

describe("fact grounding", () => {
  const text = "A 2012 survey measured all branches of the Great Wall at 21,196 kilometres. The Ming dynasty rebuilt most sections.";
  it("accepts facts stated in the sources and rejects invented details", () => {
    expect(isGroundedIn("A survey in 2012 measured all branches of the wall at 21196 kilometres", text)).toBe(true);
    expect(isGroundedIn("The Ming dynasty rebuilt most sections of the Great Wall", text)).toBe(true);
    expect(isGroundedIn("A 2015 survey measured the wall at 21,196 kilometres", text)).toBe(false);
    expect(isGroundedIn("The wall is visible from the Moon with the naked eye", text)).toBe(false);
    expect(isGroundedIn("Ming rebuilt", text)).toBe(false);
  });
});

describe("metadata", () => {
  it("normalises hashtags, adds #Shorts and enforces YouTube limits", () => {
    const meta = sanitizeMetadata({
      title: `"${"A very long title ".repeat(10)}"`,
      description: "desc <b>bold</b>",
      hashtags: ["space facts", "#Science", "#science", "Astronauts!"],
      tags: Array.from({ length: 100 }, (_, i) => `tag number ${i}`),
      thumbnailText: "one two three four five six",
    });
    expect(meta.title.length).toBeLessThanOrEqual(100);
    expect(meta.hashtags).toContain("#Shorts");
    expect(meta.hashtags.filter((h) => h.toLowerCase() === "#science")).toHaveLength(1);
    expect(meta.tags.join(",").length).toBeLessThanOrEqual(500);
    expect(meta.description).not.toContain("<");
    expect(meta.thumbnailText.split(" ")).toHaveLength(5);
    expect(normalizeHashtag("  #Space Facts! ")).toBe("#SpaceFacts");
  });

  it("rejects non-English, all-caps and duplicate titles", () => {
    const good = { title: "Why Astronauts Come Home Taller", description: "Gravity squeezes your spine every day, but in orbit that pressure disappears and astronauts grow.", hashtags: ["#Space", "#Shorts"], tags: ["space"], thumbnailText: "Taller In Space" };
    expect(checkMetadata(good, []).passed).toBe(true);
    expect(checkMetadata({ ...good, title: "Miks astronaudid kosmoses pikemaks kasvavad" }, []).passed).toBe(false);
    expect(checkMetadata({ ...good, title: "ASTRONAUTS GROW TALLER IN SPACE" }, []).passed).toBe(false);
    expect(checkMetadata(good, ["Why Astronauts Come Home Taller"]).passed).toBe(false);
  });

  it("appends media credits and hashtags to the description", () => {
    const text = composeDescription({ description: "Summary.", hashtags: ["#Space", "#Shorts"] }, { credits: ["Stock footage: Jane (Pexels)"], appendHashtags: true });
    expect(text).toBe("Summary.\n\nCredits:\nStock footage: Jane (Pexels)\n\n#Space #Shorts");
  });
});
