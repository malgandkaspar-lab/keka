import { readFile } from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "@/lib/errors";
import { withWorkDir } from "@/lib/workdir";
import { ensureModel, LOCAL_MODELS } from "@/services/local-ai/models";
import { loadSherpa, localThreads, type OfflineTtsEngine } from "@/services/local-ai/sherpa";
import { ffmpeg } from "@/services/video/ffmpeg";
import { KOKORO_VOICES } from "@/config/catalog";
import type { SynthesisRequest, SynthesisResult, TTSProvider, VoiceInfo } from "./types";

export { KOKORO_VOICES };

/**
 * KokoroTTSProvider - free, offline English text-to-speech (Kokoro-82M via sherpa-onnx).
 *
 * No API key and no per-character cost. The English-only Kokoro v0.19 model is used,
 * so narration is always English. The model (~100 MB) is downloaded automatically on
 * first use. Supported setting: speed (other ElevenLabs-style settings do not exist
 * for this engine and are therefore not exposed).
 * Output: MP3 (converted from the engine's 24 kHz PCM with FFmpeg). Word timings come
 * from speech recognition of the generated audio.
 */

let engine: Promise<OfflineTtsEngine> | undefined;

async function getEngine(): Promise<OfflineTtsEngine> {
  engine ??= (async () => {
    const dir = await ensureModel(LOCAL_MODELS["kokoro-en"]);
    return loadSherpa().OfflineTts.createAsync({
      model: {
        kokoro: {
          model: path.join(dir, "model.int8.onnx"),
          voices: path.join(dir, "voices.bin"),
          tokens: path.join(dir, "tokens.txt"),
          dataDir: path.join(dir, "espeak-ng-data"),
        },
        numThreads: localThreads(),
        debug: false,
        provider: "cpu",
      },
      maxNumSentences: 1,
    });
  })().catch((error) => {
    engine = undefined;
    throw error;
  });
  return engine;
}

export class KokoroTTSProvider implements TTSProvider {
  readonly name = "kokoro";
  readonly costPer1kChars = 0;
  readonly settingRanges = { speed: { min: 0.7, max: 1.3, default: 1.0 } } as const;

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    const voice = KOKORO_VOICES.find((v) => v.voiceId === request.voiceId);
    if (!voice) throw new ValidationError(`Unknown Kokoro voice "${request.voiceId}"`);
    const speed = Math.min(1.3, Math.max(0.7, request.settings.speed ?? 1));
    const tts = await getEngine();
    const audio = await tts.generateAsync({ text: request.text, sid: voice.sid, speed });
    if (request.signal?.aborted) throw request.signal.reason ?? new Error("aborted");
    return withWorkDir("kokoro", async (dir) => {
      const wav = path.join(dir, "voice.wav");
      const mp3 = path.join(dir, "voice.mp3");
      loadSherpa().writeWave(wav, audio);
      await ffmpeg(["-i", wav, "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "160k", mp3], { timeoutMs: 120_000, signal: request.signal });
      return { audio: await readFile(mp3), mimeType: "audio/mpeg", extension: "mp3", alignment: null, characters: request.text.length };
    });
  }

  async listVoices(): Promise<VoiceInfo[]> {
    return KOKORO_VOICES.map((v) => ({
      voiceId: v.voiceId,
      name: v.name,
      description: v.description,
      gender: v.gender,
      accent: v.accent,
      styles: v.styles,
      englishCapable: true,
    }));
  }
}
