import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getEnv } from "@/config/env";
import { ExternalServiceError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { sleep } from "@/lib/http";

/**
 * Local model manager for the free, offline speech models (no API costs).
 *
 * Models are downloaded once from their official GitHub release (k2-fsa/sherpa-onnx)
 * into LOCAL_MODELS_DIR and reused afterwards. A lock directory prevents several
 * worker processes from downloading the same model at the same time.
 *
 *  - kokoro-en:   Kokoro-82M English TTS (11 English voices), int8, ~100 MB download
 *  - parakeet-en: NVIDIA Parakeet TDT 0.6B v2 English speech recognition with
 *                 timestamps, int8, ~480 MB download
 */
export interface LocalModelSpec {
  id: string;
  url: string;
  directory: string;
  files: string[];
  license: string;
}

export const LOCAL_MODELS: Record<"kokoro-en" | "parakeet-en", LocalModelSpec> = {
  "kokoro-en": {
    id: "kokoro-en",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-en-v0_19.tar.bz2",
    directory: "kokoro-int8-en-v0_19",
    files: ["model.int8.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"],
    license: "Apache-2.0 (Kokoro-82M)",
  },
  "parakeet-en": {
    id: "parakeet-en",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
    directory: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    files: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
    license: "CC-BY-4.0 (NVIDIA Parakeet TDT 0.6B v2)",
  },
};

const log = createLogger({ module: "local-models" });
const inFlight = new Map<string, Promise<string>>();

export function modelsRoot(): string {
  return path.resolve(getEnv().LOCAL_MODELS_DIR);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isModelInstalled(spec: LocalModelSpec): Promise<boolean> {
  const dir = path.join(modelsRoot(), spec.directory);
  for (const file of spec.files) if (!(await exists(path.join(dir, file)))) return false;
  return true;
}

function extract(archive: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xjf", archive, "-C", destination], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}: ${stderr.slice(-500)}`))));
  });
}

async function acquireLock(lockDir: string): Promise<() => Promise<void>> {
  for (let i = 0; i < 1800; i++) {
    try {
      await mkdir(lockDir);
      return () => rm(lockDir, { recursive: true, force: true });
    } catch {
      // Stale lock (older than 30 minutes) from a crashed download.
      const info = await stat(lockDir).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 30 * 60_000) await rm(lockDir, { recursive: true, force: true });
      await sleep(1000);
    }
  }
  throw new Error(`Timed out waiting for model download lock ${lockDir}`);
}

async function download(spec: LocalModelSpec): Promise<string> {
  const root = modelsRoot();
  const dir = path.join(root, spec.directory);
  await mkdir(root, { recursive: true });
  const release = await acquireLock(path.join(root, `.${spec.id}.lock`));
  try {
    if (await isModelInstalled(spec)) return dir;
    log.info({ model: spec.id, url: spec.url }, "downloading local model (first use only)");
    const archive = path.join(root, `.${spec.id}.download.tar.bz2`);
    const res = await fetch(spec.url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new ExternalServiceError("model-download", `HTTP ${res.status} for ${spec.url}`, { retryable: true });
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(archive));
    const staging = path.join(root, `.${spec.id}.staging`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await extract(archive, staging);
    await rm(dir, { recursive: true, force: true });
    await rename(path.join(staging, spec.directory), dir);
    await rm(staging, { recursive: true, force: true });
    await rm(archive, { force: true });
    if (!(await isModelInstalled(spec))) throw new Error(`Model ${spec.id} is incomplete after extraction`);
    log.info({ model: spec.id }, "local model installed");
    return dir;
  } finally {
    await release();
  }
}

/** Returns the local directory of a model, downloading it on first use. */
export async function ensureModel(spec: LocalModelSpec): Promise<string> {
  if (await isModelInstalled(spec)) return path.join(modelsRoot(), spec.directory);
  let pending = inFlight.get(spec.id);
  if (!pending) {
    pending = download(spec).finally(() => inFlight.delete(spec.id));
    inFlight.set(spec.id, pending);
  }
  return pending;
}
