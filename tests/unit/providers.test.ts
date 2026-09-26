import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ElevenLabsSTTProvider, ElevenLabsTTSProvider } from "@/services/tts/elevenlabs";
import { OpenAIWhisperSTTProvider } from "@/services/tts/openai-whisper";
import { PexelsProvider } from "@/services/footage/pexels";
import { AnthropicProvider } from "@/services/ai/anthropic-provider";
import { request } from "@/lib/http";
import { ContentPolicyError, ExternalServiceError, MissingCredentialError, RateLimitError } from "@/lib/errors";
import { requireCredential, resetEnvCache } from "@/config/env";
import { db, disconnectDb } from "@/lib/db";

/** Provider integrations with the network mocked (tests only). */
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("resilient HTTP client", () => {
  it("retries 5xx and honours Retry-After on 429", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const res = await request("https://api.example.com/x", { provider: "test", baseDelayMs: 1, retries: 3 });
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry 4xx client errors and reports the provider", async () => {
    fetchMock.mockResolvedValue(new Response("bad key", { status: 401 }));
    await expect(request("https://api.example.com/x", { provider: "test", baseDelayMs: 1 })).rejects.toMatchObject({ provider: "test", retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("raises RateLimitError when rate limits persist", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 429, headers: { "retry-after": "0" } }));
    await expect(request("https://api.example.com/x", { provider: "test", retries: 1, baseDelayMs: 1 })).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("ElevenLabs", () => {
  it("synthesises with timestamps and enforces English on supporting models", async () => {
    const audio = Buffer.alloc(4000, 1).toString("base64");
    fetchMock.mockResolvedValue(
      jsonResponse({ audio_base64: audio, alignment: { characters: ["H", "i"], character_start_times_seconds: [0, 0.1], character_end_times_seconds: [0.1, 0.2] } }),
    );
    const tts = new ElevenLabsTTSProvider("xi-key");
    const result = await tts.synthesize({ text: "Hi", voiceId: "voice123", modelId: "eleven_turbo_v2_5", settings: { speed: 1.05, stability: 0.4 } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/text-to-speech/voice123/with-timestamps");
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    expect(body.language_code).toBe("en");
    expect(body.voice_settings).toMatchObject({ speed: 1.05, stability: 0.4 });
    expect((init!.headers as Record<string, string>)["xi-api-key"]).toBe("xi-key");
    expect(result.alignment?.characters).toEqual(["H", "i"]);
    expect(result.audio.length).toBe(4000);
  });

  it("does not send language_code to models without language enforcement", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ audio_base64: Buffer.alloc(2000).toString("base64") }));
    await new ElevenLabsTTSProvider("k").synthesize({ text: "Hello", voiceId: "v", modelId: "eleven_multilingual_v2", settings: {} });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).not.toHaveProperty("language_code");
  });

  it("filters the voice catalogue to English-capable voices", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        voices: [
          { voice_id: "a", name: "Brian", labels: { accent: "american", gender: "male" } },
          { voice_id: "b", name: "Jaan", labels: { accent: "estonian" } },
          { voice_id: "c", name: "Multi", verified_languages: [{ language: "en" }, { language: "de" }] },
        ],
      }),
    );
    const voices = await new ElevenLabsTTSProvider("k").listVoices();
    expect(voices.filter((v) => v.englishCapable).map((v) => v.voiceId)).toEqual(["a", "c"]);
  });

  it("transcribes with English forced and word timestamps", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        text: "Hello world",
        language_code: "eng",
        words: [
          { text: "Hello", start: 0, end: 0.4, type: "word" },
          { text: " ", start: 0.4, end: 0.5, type: "spacing" },
          { text: "world", start: 0.5, end: 0.9, type: "word" },
        ],
      }),
    );
    const result = await new ElevenLabsSTTProvider("k").transcribe(Buffer.from("audio"), "a.mp3");
    const form = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect(form.get("language_code")).toBe("en");
    expect(form.get("timestamps_granularity")).toBe("word");
    expect(result.words.map((w) => w.text)).toEqual(["Hello", "world"]);
  });

  it("Whisper requests English verbose JSON with word timings", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: "Hi", language: "english", words: [{ word: "Hi", start: 0, end: 0.3 }] }));
    const result = await new OpenAIWhisperSTTProvider("sk").transcribe(Buffer.from("a"), "a.mp3");
    const form = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect(form.get("language")).toBe("en");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(result.language).toBe("en");
  });
});

describe("Pexels", () => {
  afterEach(async () => {
    await db.apiCache.deleteMany({ where: { namespace: "footage" } });
  });

  it("maps search results with provenance and caches them", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        videos: [
          {
            id: 42,
            width: 1080,
            height: 1920,
            url: "https://www.pexels.com/video/42/",
            image: "https://images.pexels.com/42.jpg",
            duration: 12,
            user: { name: "Jane Doe", url: "https://www.pexels.com/@jane" },
            video_files: [
              { link: "https://videos.pexels.com/42-hd.mp4", width: 1080, height: 1920, fps: 30, quality: "hd", file_type: "video/mp4" },
              { link: "https://videos.pexels.com/42.webm", width: 1080, height: 1920, file_type: "video/webm" },
            ],
          },
        ],
      }),
    );
    const pexels = new PexelsProvider("px-key");
    const query = `astronaut floating ${Date.now()}`;
    const results = await pexels.searchVideos(query, { orientation: "portrait" });
    expect(results[0]).toMatchObject({ id: "42", author: "Jane Doe", license: "Pexels License", pageUrl: "https://www.pexels.com/video/42/" });
    expect(results[0]!.files).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("orientation=portrait");
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe("px-key");
    await pexels.searchVideos(query, { orientation: "portrait" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to download from non-Pexels hosts", async () => {
    await expect(new PexelsProvider("k").download("https://evil.example.com/x.mp4")).rejects.toBeInstanceOf(ExternalServiceError);
  });
});

describe("Anthropic provider", () => {
  function fakeClient(response: Record<string, unknown>) {
    const parse = vi.fn().mockResolvedValue(response);
    return { client: { beta: { messages: { parse, create: vi.fn() } } } as unknown as Anthropic, parse };
  }

  it("requests structured output with adaptive thinking and server-side fallbacks", async () => {
    const { client, parse } = fakeClient({ stop_reason: "end_turn", parsed_output: { ok: true }, usage: { input_tokens: 100, output_tokens: 50 }, model: "claude-opus-5" });
    const ai = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5", client });
    const result = await ai.generateStructured({ purpose: "t", system: "s", prompt: "p", schema: z.object({ ok: z.boolean() }) });
    expect(result.data).toEqual({ ok: true });
    expect(result.usage.costUsd).toBeGreaterThan(0);
    const params = parse.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.fallbacks).toBe("default");
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
  });

  it("maps refusals to content policy errors", async () => {
    const { client } = fakeClient({ stop_reason: "refusal", stop_details: { category: "cyber" }, parsed_output: null, usage: {} });
    const ai = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5", client });
    await expect(ai.generateStructured({ purpose: "t", system: "s", prompt: "p", schema: z.object({}) })).rejects.toBeInstanceOf(ContentPolicyError);
  });

  it("does not send fallbacks to models that do not support them", async () => {
    const { client, parse } = fakeClient({ stop_reason: "end_turn", parsed_output: {}, usage: {} });
    await new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-5", client }).generateStructured({ purpose: "t", system: "s", prompt: "p", schema: z.object({}) });
    expect(parse.mock.calls[0]![0]).not.toHaveProperty("fallbacks");
  });
});

describe("credentials", () => {
  it("names the missing environment variable", () => {
    const previous = process.env.PEXELS_API_KEY;
    delete process.env.PEXELS_API_KEY;
    resetEnvCache();
    expect(() => requireCredential("PEXELS_API_KEY")).toThrow(MissingCredentialError);
    expect(() => requireCredential("PEXELS_API_KEY")).toThrow(/PEXELS_API_KEY/);
    if (previous) process.env.PEXELS_API_KEY = previous;
    resetEnvCache();
  });
});

afterAll(async () => {
  await disconnectDb();
});

