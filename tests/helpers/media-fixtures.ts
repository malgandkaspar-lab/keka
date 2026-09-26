import path from "node:path";
import { mkdir } from "node:fs/promises";
import { ffmpeg } from "@/services/video/ffmpeg";

/**
 * Test-only media fixtures generated with FFmpeg's built-in sources
 * (used by render/QC tests; never used by production code).
 */
export async function makeClip(dir: string, name: string, opts: { width: number; height: number; durationSec: number; pattern?: string }) {
  await mkdir(dir, { recursive: true });
  const out = path.join(dir, `${name}.mp4`);
  const source = opts.pattern ?? "testsrc2";
  await ffmpeg(["-f", "lavfi", "-i", `${source}=s=${opts.width}x${opts.height}:r=30:d=${opts.durationSec}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out]);
  return out;
}

export async function makeImage(dir: string, name: string, width: number, height: number) {
  await mkdir(dir, { recursive: true });
  const out = path.join(dir, `${name}.jpg`);
  await ffmpeg(["-f", "lavfi", "-i", `mandelbrot=s=${width}x${height}`, "-frames:v", "1", out]);
  return out;
}

/** Speech-like test signal: modulated tones with pauses (audible, not silent). */
export async function makeVoice(dir: string, durationSec: number) {
  await mkdir(dir, { recursive: true });
  const out = path.join(dir, "voice.mp3");
  const expr = "0.5*sin(2*PI*(180+40*sin(2*PI*3*t))*t)*(0.6+0.4*sin(2*PI*4*t))*gt(sin(2*PI*0.5*t)+0.8\\,0)";
  await ffmpeg(["-f", "lavfi", "-i", `aevalsrc=exprs='${expr}':s=44100:d=${durationSec}`, "-c:a", "libmp3lame", "-b:a", "128k", out]);
  return out;
}
