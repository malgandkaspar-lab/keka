import { requireCredential } from "@/config/env";
import type { UserSettings } from "@/services/settings/schema";
import { ElevenLabsSTTProvider, ElevenLabsTTSProvider } from "./elevenlabs";
import { KokoroTTSProvider } from "./kokoro";
import { OpenAIWhisperSTTProvider } from "./openai-whisper";
import { ParakeetSTTProvider } from "./parakeet";
import type { SpeechToTextProvider, TTSProvider } from "./types";

/** Provider factories (configured by user settings, credentials from env). */
let ttsOverride: TTSProvider | undefined;
let sttOverride: SpeechToTextProvider | undefined;

export function getTTSProvider(settings: Pick<UserSettings, "ttsProvider">): TTSProvider {
  if (ttsOverride) return ttsOverride;
  switch (settings.ttsProvider) {
    case "kokoro":
      return new KokoroTTSProvider();
    case "elevenlabs":
      return new ElevenLabsTTSProvider(requireCredential("ELEVENLABS_API_KEY"));
    default:
      throw new Error(`Unsupported TTS provider: ${String(settings.ttsProvider)}`);
  }
}

export function getSTTProvider(settings: Pick<UserSettings, "sttProvider">): SpeechToTextProvider {
  if (sttOverride) return sttOverride;
  switch (settings.sttProvider) {
    case "parakeet":
      return new ParakeetSTTProvider();
    case "elevenlabs":
      return new ElevenLabsSTTProvider(requireCredential("ELEVENLABS_API_KEY"));
    case "openai":
      return new OpenAIWhisperSTTProvider(requireCredential("OPENAI_API_KEY"));
    default:
      throw new Error(`Unsupported speech-to-text provider: ${String(settings.sttProvider)}`);
  }
}

export function setSpeechProvidersForTesting(tts?: TTSProvider, stt?: SpeechToTextProvider): void {
  ttsOverride = tts;
  sttOverride = stt;
}

export type { SpeechToTextProvider, TTSProvider } from "./types";
