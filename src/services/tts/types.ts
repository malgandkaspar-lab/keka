/**
 * TTSProvider / SpeechToTextProvider
 *
 * Purpose: provider-neutral interfaces for English narration and transcription.
 * Implementations: ElevenLabsTTSProvider, ElevenLabsSTTProvider, OpenAIWhisperSTTProvider.
 */
export interface WordTiming {
  text: string;
  start: number;
  end: number;
}

export interface CharacterAlignment {
  characters: string[];
  starts: number[];
  ends: number[];
}

/** Only parameters the provider actually supports are exposed. */
export interface VoiceSettings {
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  speed?: number;
}

export interface SynthesisRequest {
  text: string;
  voiceId: string;
  modelId: string;
  settings: VoiceSettings;
  signal?: AbortSignal;
}

export interface SynthesisResult {
  audio: Buffer;
  mimeType: string;
  extension: string;
  alignment: CharacterAlignment | null;
  requestId?: string;
  characters: number;
}

export interface VoiceInfo {
  voiceId: string;
  name: string;
  description?: string;
  gender?: string;
  accent?: string;
  styles: string[];
  previewUrl?: string;
  englishCapable: boolean;
}

export interface TTSProvider {
  readonly name: string;
  /** Voice setting ranges supported by this provider (used by the UI and validation). */
  readonly settingRanges: Partial<Record<keyof VoiceSettings, { min: number; max: number; default: number } | "boolean">>;
  synthesize(request: SynthesisRequest): Promise<SynthesisResult>;
  listVoices(signal?: AbortSignal): Promise<VoiceInfo[]>;
}

export interface TranscriptionResult {
  text: string;
  language: string | null;
  languageProbability: number | null;
  words: WordTiming[];
}

export interface SpeechToTextProvider {
  readonly name: string;
  /** Language is always forced to English where the provider supports it. */
  transcribe(audio: Buffer, filename: string, signal?: AbortSignal): Promise<TranscriptionResult>;
}
