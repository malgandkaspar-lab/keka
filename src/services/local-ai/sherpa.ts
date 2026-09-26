import { createRequire } from "node:module";
import { getEnv } from "@/config/env";
import { MediaProcessingError } from "@/lib/errors";

/**
 * Lazy loader for the sherpa-onnx native addon (offline ONNX speech engines).
 * Loaded only in processes that actually synthesise or transcribe speech (the worker).
 */
export interface GeneratedAudio {
  samples: Float32Array;
  sampleRate: number;
}

export interface OfflineTtsEngine {
  numSpeakers: number;
  sampleRate: number;
  generateAsync(request: { text: string; sid: number; speed: number }): Promise<GeneratedAudio>;
}

export interface OfflineRecognitionResult {
  text: string;
  tokens: string[];
  timestamps: number[];
  durations?: number[];
}

export interface OfflineStreamHandle {
  acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void;
}

export interface OfflineRecognizerEngine {
  createStream(): OfflineStreamHandle;
  decodeAsync(stream: OfflineStreamHandle): Promise<OfflineRecognitionResult>;
}

interface SherpaModule {
  OfflineTts: { createAsync(config: unknown): Promise<OfflineTtsEngine> };
  OfflineRecognizer: { createAsync(config: unknown): Promise<OfflineRecognizerEngine> };
  readWave(path: string): GeneratedAudio;
  writeWave(path: string, audio: GeneratedAudio): void;
}

let sherpa: SherpaModule | undefined;

export function loadSherpa(): SherpaModule {
  if (!sherpa) {
    try {
      const require = createRequire(import.meta.url);
      sherpa = require("sherpa-onnx-node") as SherpaModule;
    } catch (error) {
      throw new MediaProcessingError(
        `The local speech engine (sherpa-onnx-node) could not be loaded: ${(error as Error).message}`,
        {},
        false,
      );
    }
  }
  return sherpa;
}

export function localThreads(): number {
  return getEnv().LOCAL_AI_THREADS;
}
