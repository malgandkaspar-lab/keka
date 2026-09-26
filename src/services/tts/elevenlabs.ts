import { z } from "zod";
import { ExternalServiceError } from "@/lib/errors";
import { request, requestJson } from "@/lib/http";
import type {
  SpeechToTextProvider,
  SynthesisRequest,
  SynthesisResult,
  TranscriptionResult,
  TTSProvider,
  VoiceInfo,
  VoiceSettings,
} from "./types";

/**
 * ElevenLabs integration (text-to-speech with character timestamps, voice catalogue and
 * Scribe speech-to-text).
 *
 * API: https://api.elevenlabs.io - authenticated with the `xi-api-key` header.
 * Configuration: ELEVENLABS_API_KEY.
 * English: scripts are validated as English before synthesis; the `language_code`
 * parameter forces English on models that support language enforcement, and
 * transcription is always requested with language_code=en.
 */
const BASE_URL = "https://api.elevenlabs.io";
const PROVIDER = "elevenlabs";
/** Models that accept `language_code` enforcement. */
const LANGUAGE_ENFORCING_MODELS = new Set(["eleven_turbo_v2_5", "eleven_flash_v2_5", "eleven_v3"]);

const withTimestampsSchema = z.object({
  audio_base64: z.string(),
  alignment: z
    .object({
      characters: z.array(z.string()),
      character_start_times_seconds: z.array(z.number()),
      character_end_times_seconds: z.array(z.number()),
    })
    .nullable()
    .optional(),
});

const voicesSchema = z.object({
  voices: z.array(
    z.object({
      voice_id: z.string(),
      name: z.string(),
      category: z.string().optional().nullable(),
      preview_url: z.string().optional().nullable(),
      description: z.string().optional().nullable(),
      labels: z.record(z.string(), z.string()).optional().nullable(),
      verified_languages: z
        .array(z.object({ language: z.string() }).passthrough())
        .optional()
        .nullable(),
    }),
  ),
});

const sttSchema = z.object({
  text: z.string(),
  language_code: z.string().optional().nullable(),
  language_probability: z.number().optional().nullable(),
  words: z
    .array(
      z.object({
        text: z.string(),
        start: z.number().optional().nullable(),
        end: z.number().optional().nullable(),
        type: z.string().optional().nullable(),
      }),
    )
    .default([]),
});

export function toElevenLabsVoiceSettings(settings: VoiceSettings) {
  return {
    stability: settings.stability ?? 0.45,
    similarity_boost: settings.similarityBoost ?? 0.8,
    style: settings.style ?? 0.25,
    use_speaker_boost: settings.useSpeakerBoost ?? true,
    speed: settings.speed ?? 1.0,
  };
}

export class ElevenLabsTTSProvider implements TTSProvider {
  readonly name = PROVIDER;
  readonly settingRanges = {
    stability: { min: 0, max: 1, default: 0.45 },
    similarityBoost: { min: 0, max: 1, default: 0.8 },
    style: { min: 0, max: 1, default: 0.25 },
    speed: { min: 0.7, max: 1.2, default: 1.0 },
    useSpeakerBoost: "boolean",
  } as const;

  constructor(private readonly apiKey: string) {}

  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    const body: Record<string, unknown> = {
      text: req.text,
      model_id: req.modelId,
      voice_settings: toElevenLabsVoiceSettings(req.settings),
    };
    if (LANGUAGE_ENFORCING_MODELS.has(req.modelId)) body.language_code = "en";

    const res = await requestJson<unknown>(
      `${BASE_URL}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}/with-timestamps?output_format=mp3_44100_128`,
      {
        provider: PROVIDER,
        method: "POST",
        headers: { "xi-api-key": this.apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 120_000,
        retries: 3,
        signal: req.signal,
      },
    );
    const parsed = withTimestampsSchema.safeParse(res);
    if (!parsed.success) throw new ExternalServiceError(PROVIDER, "unexpected text-to-speech response shape");
    const audio = Buffer.from(parsed.data.audio_base64, "base64");
    if (audio.length < 1000) throw new ExternalServiceError(PROVIDER, "text-to-speech returned empty audio", { retryable: true });
    const alignment = parsed.data.alignment
      ? {
          characters: parsed.data.alignment.characters,
          starts: parsed.data.alignment.character_start_times_seconds,
          ends: parsed.data.alignment.character_end_times_seconds,
        }
      : null;
    return { audio, mimeType: "audio/mpeg", extension: "mp3", alignment, characters: req.text.length };
  }

  async listVoices(signal?: AbortSignal): Promise<VoiceInfo[]> {
    const res = await requestJson<unknown>(`${BASE_URL}/v1/voices`, {
      provider: PROVIDER,
      headers: { "xi-api-key": this.apiKey },
      timeoutMs: 30_000,
      signal,
    });
    const parsed = voicesSchema.safeParse(res);
    if (!parsed.success) throw new ExternalServiceError(PROVIDER, "unexpected voices response shape");
    return parsed.data.voices.map((v) => {
      const labels = v.labels ?? {};
      const languages = (v.verified_languages ?? []).map((l) => l.language.toLowerCase());
      const accent = labels.accent?.toLowerCase();
      const englishCapable =
        languages.length === 0 ? !accent || /american|british|australian|english|irish|canadian|us|uk/.test(accent) : languages.includes("en");
      return {
        voiceId: v.voice_id,
        name: v.name,
        description: labels.description ?? v.description ?? undefined,
        gender: labels.gender,
        accent: labels.accent,
        styles: [labels.use_case, labels.descriptive, labels.description].filter((s): s is string => Boolean(s)),
        previewUrl: v.preview_url ?? undefined,
        englishCapable,
      };
    });
  }
}

export class ElevenLabsSTTProvider implements SpeechToTextProvider {
  readonly name = PROVIDER;

  constructor(
    private readonly apiKey: string,
    private readonly modelId = "scribe_v1",
  ) {}

  async transcribe(audio: Buffer, filename: string, signal?: AbortSignal): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append("model_id", this.modelId);
    form.append("language_code", "en");
    form.append("timestamps_granularity", "word");
    form.append("tag_audio_events", "false");
    form.append("diarize", "false");
    form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }), filename);

    const res = await request(`${BASE_URL}/v1/speech-to-text`, {
      provider: `${PROVIDER}-stt`,
      method: "POST",
      headers: { "xi-api-key": this.apiKey },
      body: form,
      timeoutMs: 180_000,
      retries: 3,
      signal,
    });
    const parsed = sttSchema.safeParse(await res.json());
    if (!parsed.success) throw new ExternalServiceError(PROVIDER, "unexpected speech-to-text response shape");
    return {
      text: parsed.data.text.trim(),
      language: parsed.data.language_code ?? null,
      languageProbability: parsed.data.language_probability ?? null,
      words: parsed.data.words
        .filter((w) => (w.type ?? "word") === "word" && w.start != null && w.end != null)
        .map((w) => ({ text: w.text.trim(), start: w.start!, end: w.end! }))
        .filter((w) => w.text.length > 0),
    };
  }
}
