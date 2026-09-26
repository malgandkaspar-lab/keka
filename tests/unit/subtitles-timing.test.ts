import { describe, expect, it } from "vitest";
import { SUBTITLE_STYLE_PRESETS } from "@/config/templates";
import { alignScriptToTranscript, buildCues, cuesToSrt, layoutLines } from "@/services/subtitles/cues";
import { assColor, assTime, escapeAssText, renderAss } from "@/services/subtitles/ass";
import { charactersToWords, estimateWordTimings, mapSegmentsToTimeline, wordErrorRate } from "@/services/tts/alignment";
import { segmentNarration } from "@/services/footage/scene-planner";

const words = "You probably did not know this. Astronauts actually grow taller in space, up to two inches!"
  .split(" ")
  .map((text, i) => ({ text, start: i * 0.4, end: i * 0.4 + 0.35 }));

describe("word timings", () => {
  it("converts character alignment into words", () => {
    const chars = [..."Hi there"];
    const timings = charactersToWords({ characters: chars, starts: chars.map((_, i) => i * 0.1), ends: chars.map((_, i) => i * 0.1 + 0.1) });
    expect(timings).toEqual([
      { text: "Hi", start: 0, end: 0.2 },
      { text: "there", start: 0.30000000000000004, end: 0.8 },
    ]);
  });

  it("transfers transcript timings onto the exact script wording", () => {
    const transcript = [
      { text: "Astronauts", start: 0, end: 0.5 },
      { text: "grow", start: 0.5, end: 0.8 },
      { text: "taler", start: 0.8, end: 1.2 },
      { text: "in", start: 1.2, end: 1.3 },
      { text: "space", start: 1.3, end: 1.8 },
    ];
    const aligned = alignScriptToTranscript("Astronauts grow taller in space.", transcript);
    expect(aligned.map((w) => w.text)).toEqual(["Astronauts", "grow", "taller", "in", "space."]);
    expect(aligned[2]!.start).toBeGreaterThanOrEqual(0.8);
    expect(aligned[4]!.end).toBe(1.8);
  });

  it("measures word error rate", () => {
    expect(wordErrorRate("the quick brown fox", "the quick brown fox")).toBe(0);
    expect(wordErrorRate("the quick brown fox", "the slow brown fox")).toBe(0.25);
  });

  it("estimates timings when no alignment exists", () => {
    const est = estimateWordTimings("one two three four", 4);
    expect(est).toHaveLength(4);
    expect(est.at(-1)!.end).toBeLessThanOrEqual(4);
  });

  it("maps scene narration segments onto the timeline contiguously", () => {
    const ranges = mapSegmentsToTimeline(["You probably did not know this.", "Astronauts actually grow taller in space, up to two inches!"], words, 7);
    expect(ranges[0]!.start).toBe(0);
    expect(ranges[0]!.end).toBe(ranges[1]!.start);
    expect(ranges[1]!.end).toBeGreaterThanOrEqual(7);
  });
});

describe("scene segmentation", () => {
  it("splits narration into shots that respect the template's shot lengths", () => {
    const segments = segmentNarration(words, 6.5, { targetShotSec: 2, minShotSec: 1.2, maxShotSec: 3 });
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments[0]!.start).toBe(0);
    for (let i = 1; i < segments.length; i++) expect(segments[i]!.start).toBe(segments[i - 1]!.end);
    expect(segments.map((s) => s.text).join(" ")).toBe(words.map((w) => w.text).join(" "));
    for (const s of segments.slice(0, -1)) expect(s.end - s.start).toBeLessThanOrEqual(3.5);
  });
});

describe("subtitle cues", () => {
  it("builds short phrases broken at punctuation", () => {
    const cues = buildCues(words, SUBTITLE_STYLE_PRESETS.fast_viral!);
    expect(cues.every((c) => c.words.length <= 3)).toBe(true);
    expect(cues.some((c) => c.words.at(-1)!.text.endsWith("this."))).toBe(true);
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.end - 1e-9);
  });

  it("never lays out lines wider than the frame", () => {
    const style = SUBTITLE_STYLE_PRESETS.cinematic!;
    const lines = layoutLines(["Astronauts", "actually", "grow", "taller", "in", "space"], style);
    expect(lines.length).toBeGreaterThan(1);
  });

  it("renders valid ASS with styling and escaped text", () => {
    const ass = renderAss(buildCues(words, SUBTITLE_STYLE_PRESETS.fast_viral!), SUBTITLE_STYLE_PRESETS.fast_viral!);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toMatch(/Dialogue: 0,0:00:00\.00/);
    expect(ass).toContain("YOU");
    expect(escapeAssText("a {\\b1} b")).toBe("a (\\\\b1) b");
    expect(assColor("#FFD400")).toBe("&H0000D4FF");
    expect(assTime(61.234)).toBe("0:01:01.23");
  });

  it("exports SRT", () => {
    const srt = cuesToSrt(buildCues(words.slice(0, 3), SUBTITLE_STYLE_PRESETS.minimal!));
    expect(srt).toMatch(/^1\n00:00:00,000 --> 00:00:0\d,\d{3}\nYou probably did/);
  });
});
