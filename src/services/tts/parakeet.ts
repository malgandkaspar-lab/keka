import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withWorkDir } from "@/lib/workdir";
import { ensureModel, LOCAL_MODELS } from "@/services/local-ai/models";
import { loadSherpa, localThreads, type OfflineRecognitionResult, type OfflineRecognizerEngine } from "@/services/local-ai/sherpa";
import { ffmpeg } from "@/services/video/ffmpeg";
import type { SpeechToTextProvider, TranscriptionResult, WordTiming } from "./types";

/**
 * ParakeetSTTProvider - free, offline English speech recognition with timestamps
 * (NVIDIA Parakeet TDT 0.6B v2 via sherpa-onnx). English-only model, no API key,
 * no per-minute cost. The model (~480 MB) is downloaded automatically on first use.
 */
let engine: Promise<OfflineRecognizerEngine> | undefined;

async function getEngine(): Promise<OfflineRecognizerEngine> {
  engine ??= (async () => {
    const dir = await ensureModel(LOCAL_MODELS["parakeet-en"]);
    return loadSherpa().OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: path.join(dir, "encoder.int8.onnx"),
          decoder: path.join(dir, "decoder.int8.onnx"),
          joiner: path.join(dir, "joiner.int8.onnx"),
        },
        tokens: path.join(dir, "tokens.txt"),
        numThreads: localThreads(),
        provider: "cpu",
        debug: 0,
        modelType: "nemo_transducer",
      },
    });
  })().catch((error) => {
    engine = undefined;
    throw error;
  });
  return engine;
}

/**
 * Groups sub-word tokens into words. A token starting with a space (or the first
 * token) begins a new word; a word ends where its last token ends.
 */
export function tokensToWords(result: Pick<OfflineRecognitionResult, "tokens" | "timestamps" | "durations">, totalSec?: number): WordTiming[] {
  const words: WordTiming[] = [];
  result.tokens.forEach((token, i) => {
    const start = result.timestamps[i] ?? 0;
    const duration = result.durations?.[i] ?? Math.max(0.04, (result.timestamps[i + 1] ?? start + 0.08) - start);
    const end = start + duration;
    const startsWord = i === 0 || /^\s/.test(token) || token.startsWith("▁");
    const clean = token.replace(/^[\s▁]+/, "");
    if (startsWord || words.length === 0) {
      if (clean) words.push({ text: clean, start, end });
    } else {
      const last = words.at(-1)!;
      last.text += clean;
      last.end = end;
    }
  });
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return words
    .filter((w) => w.text.length > 0)
    .map((w) => ({ text: w.text, start: round(w.start), end: round(totalSec !== undefined ? Math.min(w.end, totalSec) : w.end) }));
}

export class ParakeetSTTProvider implements SpeechToTextProvider {
  readonly name = "parakeet";
  readonly costPerMinute = 0;

  async transcribe(audio: Buffer, filename: string, signal?: AbortSignal): Promise<TranscriptionResult> {
    const recognizer = await getEngine();
    return withWorkDir("parakeet", async (dir) => {
      const input = path.join(dir, filename);
      const wav = path.join(dir, "input.wav");
      await writeFile(input, audio);
      await ffmpeg(["-i", input, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], { timeoutMs: 120_000, signal });
      const wave = loadSherpa().readWave(wav);
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
      const result = await recognizer.decodeAsync(stream);
      const words = tokensToWords(result, wave.samples.length / wave.sampleRate);
      return { text: result.text.trim(), language: "en", languageProbability: null, words };
    });
  }
}
