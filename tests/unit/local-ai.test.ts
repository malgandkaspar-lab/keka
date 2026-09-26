import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OllamaProvider } from "@/services/ai/ollama-provider";
import { tokensToWords } from "@/services/tts/parakeet";
import { researchOnWikipedia } from "@/services/research/wikipedia";
import { ExternalServiceError } from "@/lib/errors";

/** Free local providers with the network mocked (tests only). */
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const chat = (content: unknown) => json({ message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, prompt_eval_count: 120, eval_count: 40 });

describe("OllamaProvider", () => {
  const schema = z.object({ title: z.string(), score: z.number().min(0).max(10) });

  it("sends the JSON schema as the output format and validates the result", async () => {
    fetchMock.mockResolvedValue(chat({ title: "Octopus hearts", score: 8 }));
    const ai = new OllamaProvider("qwen2.5:7b", "http://localhost:11434");
    const result = await ai.generateStructured({ purpose: "t", system: "sys", prompt: "go", schema });
    expect(result.data).toEqual({ title: "Octopus hearts", score: 8 });
    expect(result.usage.costUsd).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:11434/api/chat");
    const body = JSON.parse(String(init!.body)) as { model: string; stream: boolean; format: { type: string; properties: Record<string, unknown> } };
    expect(body.model).toBe("qwen2.5:7b");
    expect(body.stream).toBe(false);
    expect(body.format.type).toBe("object");
    expect(Object.keys(body.format.properties)).toEqual(["title", "score"]);
  });

  it("asks the model to repair invalid JSON", async () => {
    fetchMock.mockResolvedValueOnce(chat("not json at all")).mockResolvedValueOnce(chat({ title: "x", score: 42 })).mockResolvedValueOnce(chat({ title: "Fixed", score: 7 }));
    const ai = new OllamaProvider("qwen2.5:7b", "http://localhost:11434");
    const result = await ai.generateStructured({ purpose: "t", system: "sys", prompt: "go", schema });
    expect(result.data.title).toBe("Fixed");
    const lastMessages = (JSON.parse(String(fetchMock.mock.calls[2]![1]!.body)) as { messages: { role: string; content: string }[] }).messages;
    expect(lastMessages.at(-1)!.content).toContain("score");
  });

  it("explains a missing model with the pull command", async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"model not found"}', { status: 404 }));
    const ai = new OllamaProvider("llama3.1:8b", "http://localhost:11434");
    await expect(ai.generateStructured({ purpose: "t", system: "s", prompt: "p", schema })).rejects.toThrow(/ollama pull llama3.1:8b/);
  });

  it("explains when Ollama is not running", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const ai = new OllamaProvider("qwen2.5:7b", "http://localhost:11434");
    const error = await ai.generateStructured({ purpose: "t", system: "s", prompt: "p", schema }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as Error).message).toMatch(/not reachable/);
  }, 30_000);

  it("researches on Wikipedia instead of paid web search", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/chat")) return chat({ queries: ["astronaut spine microgravity", "spaceflight height"] });
      if (url.includes("list=search")) return json({ query: { search: [{ title: "Effect of spaceflight on the human body", pageid: 11 }] } });
      return json({ query: { pages: { "11": { title: "Effect of spaceflight on the human body", fullurl: "https://en.wikipedia.org/wiki/Effect_of_spaceflight_on_the_human_body", extract: "In microgravity the spine lengthens. ".repeat(20) } } } });
    });
    const ai = new OllamaProvider("qwen2.5:7b", "http://localhost:11434");
    const result = await ai.researchWithWebSearch({ system: "s", prompt: "Research: Why do astronauts grow taller in space?" });
    expect(result.sources).toEqual([expect.objectContaining({ url: "https://en.wikipedia.org/wiki/Effect_of_spaceflight_on_the_human_body" })]);
    expect(result.notes).toContain("spine lengthens");
    expect(result.usage.costUsd).toBe(0);
    const wikiCall = fetchMock.mock.calls.find(([u]) => String(u).includes("wikipedia"));
    expect((wikiCall![1]!.headers as Record<string, string>)["user-agent"]).toMatch(/ShortsFactory/);
  });

  it("deduplicates Wikipedia pages across queries", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("list=search")) return json({ query: { search: [{ title: "Same", pageid: 1 }] } });
      return json({ query: { pages: { "1": { title: "Same", fullurl: "https://en.wikipedia.org/wiki/Same", extract: "Long text. ".repeat(40) } } } });
    });
    const pages = await researchOnWikipedia(["a", "b", "c"]);
    expect(pages).toHaveLength(1);
  });
});

describe("Parakeet token grouping", () => {
  it("merges sub-word tokens into timed words", () => {
    const words = tokensToWords({
      tokens: [" Wh", "y", " do", " a", "st", "ron", "auts", " grow", "?"],
      timestamps: [0, 0.2, 0.4, 0.56, 0.64, 0.72, 0.8, 1.0, 1.3],
      durations: [0.2, 0.1, 0.16, 0.08, 0.08, 0.08, 0.16, 0.24, 0.08],
    });
    expect(words.map((w) => w.text)).toEqual(["Why", "do", "astronauts", "grow?"]);
    expect(words[2]).toEqual({ text: "astronauts", start: 0.56, end: 0.96 });
  });
});
