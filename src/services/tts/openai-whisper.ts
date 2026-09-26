import { z } from "zod";
import { ExternalServiceError } from "@/lib/errors";
import { request } from "@/lib/http";
import type { SpeechToTextProvider, TranscriptionResult } from "./types";

/**
 * OpenAI Whisper speech-to-text (alternative SpeechToTextProvider).
 * Configuration: OPENAI_API_KEY. Language is forced to English (`language=en`) and
 * word-level timestamps are requested.
 */
const PROVIDER = "openai-whisper";

const responseSchema = z.object({
  text: z.string(),
  language: z.string().optional().nullable(),
  words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })).default([]),
});

export class OpenAIWhisperSTTProvider implements SpeechToTextProvider {
  readonly name = PROVIDER;

  constructor(private readonly apiKey: string) {}

  async transcribe(audio: Buffer, filename: string, signal?: AbortSignal): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("language", "en");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }), filename);

    const res = await request("https://api.openai.com/v1/audio/transcriptions", {
      provider: PROVIDER,
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      timeoutMs: 180_000,
      retries: 3,
      signal,
    });
    const parsed = responseSchema.safeParse(await res.json());
    if (!parsed.success) throw new ExternalServiceError(PROVIDER, "unexpected transcription response shape");
    const language = parsed.data.language?.toLowerCase() ?? null;
    return {
      text: parsed.data.text.trim(),
      language: language === "english" ? "en" : language,
      languageProbability: null,
      words: parsed.data.words.map((w) => ({ text: w.word.trim(), start: w.start, end: w.end })).filter((w) => w.text),
    };
  }
}
