import { spawn } from "node:child_process";
import { getEnv } from "@/config/env";
import { CancelledError, MediaProcessingError, TimeoutError } from "@/lib/errors";

/**
 * Thin, safe wrapper around the FFmpeg / FFprobe binaries.
 *
 * Arguments are passed as an array (never through a shell), so file names and text
 * cannot inject commands. Every invocation has a timeout and honours an AbortSignal.
 */
export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (seconds: number) => void;
  cwd?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

function run(binary: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = 10 * 60_000, signal, onProgress, cwd } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    let settled = false;

    const finish = (error?: Error, result?: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(new CancelledError());
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new TimeoutError(`${binary} ${args[0] ?? ""}`, timeoutMs));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-20_000);
      if (onProgress) {
        const match = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(text);
        if (match) onProgress(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
      }
    });
    child.on("error", (error) =>
      finish(new MediaProcessingError(`Failed to start ${binary}: ${error.message}`, { binary }, false)),
    );
    child.on("close", (code) => {
      if (code === 0) finish(undefined, { stdout: Buffer.concat(stdout).toString(), stderr });
      else
        finish(
          new MediaProcessingError(`${binary} exited with code ${code}`, {
            binary,
            stderr: stderr.split("\n").slice(-25).join("\n"),
          }),
        );
    });
  });
}

export function ffmpeg(args: string[], options?: RunOptions): Promise<RunResult> {
  return run(getEnv().FFMPEG_PATH, ["-hide_banner", "-nostdin", "-y", ...args], options);
}

export function ffprobeRaw(args: string[], options?: RunOptions): Promise<RunResult> {
  return run(getEnv().FFPROBE_PATH, args, { timeoutMs: 60_000, ...options });
}

export interface ProbeStream {
  index: number;
  codec_type: "video" | "audio" | "subtitle" | "data";
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
  pix_fmt?: string;
  profile?: string;
}

export interface ProbeResult {
  format: { format_name?: string; duration?: string; size?: string; bit_rate?: string };
  streams: ProbeStream[];
}

export async function probe(filePath: string, options?: RunOptions): Promise<ProbeResult> {
  const { stdout } = await ffprobeRaw(
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
    options,
  );
  return JSON.parse(stdout) as ProbeResult;
}

export function parseFrameRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined;
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return undefined;
  return num / den;
}

export interface MediaInfo {
  durationSec: number;
  width?: number;
  height?: number;
  fps?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  formatName?: string;
  sizeBytes?: number;
  pixFmt?: string;
}

export async function mediaInfo(filePath: string, options?: RunOptions): Promise<MediaInfo> {
  const result = await probe(filePath, options);
  const video = result.streams.find((s) => s.codec_type === "video");
  const audio = result.streams.find((s) => s.codec_type === "audio");
  const duration = Number(result.format.duration ?? video?.duration ?? audio?.duration ?? 0);
  return {
    durationSec: Number.isFinite(duration) ? duration : 0,
    width: video?.width,
    height: video?.height,
    fps: parseFrameRate(video?.avg_frame_rate) ?? parseFrameRate(video?.r_frame_rate),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    formatName: result.format.format_name,
    sizeBytes: result.format.size ? Number(result.format.size) : undefined,
    pixFmt: video?.pix_fmt,
  };
}
