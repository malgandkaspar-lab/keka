import path from "node:path";
import { stat, writeFile } from "node:fs/promises";
import { LanguageValidationError } from "@/lib/errors";
import { analyzeLanguage } from "@/services/language/language-service";
import { ffmpeg } from "@/services/video/ffmpeg";
import { escapeFilterPath } from "@/services/video/render-engine";

/**
 * ThumbnailService
 *
 * Purpose: create an optional thumbnail from a strong frame of the rendered video with
 * minimal, highly readable English text (large bold uppercase, outlined, upper third).
 * Frame choice: the most detailed of the clean scene frames captured at render time
 * (JPEG size is a cheap proxy for detail); subtitles are never part of the frame.
 * Text is passed to FFmpeg through a file, so no escaping issues or injection.
 */

/** Extracts a frame from the middle of each clip (clean scene segments, no subtitles). */
export async function extractCandidateFrames(clips: { path: string; durationSec: number }[], workDir: string): Promise<string[]> {
  const frames: string[] = [];
  for (const [i, clip] of clips.slice(0, 5).entries()) {
    const out = path.join(workDir, `frame-${i}.jpg`);
    await ffmpeg(["-ss", Math.max(0.2, clip.durationSec / 2).toFixed(2), "-i", clip.path, "-frames:v", "1", "-q:v", "2", out], {
      timeoutMs: 60_000,
    });
    frames.push(out);
  }
  return frames;
}

export async function mostDetailedFrame(frames: string[]): Promise<string> {
  let best = frames[0]!;
  let bestSize = -1;
  for (const frame of frames) {
    const size = (await stat(frame)).size;
    if (size > bestSize) {
      best = frame;
      bestSize = size;
    }
  }
  return best;
}

export function wrapThumbnailText(text: string, maxCharsPerLine = 12): string[] {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && (line + " " + word).length > maxCharsPerLine) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

/** Composes the thumbnail from a clean base frame plus optional English text. */
export async function createThumbnail(opts: {
  baseFramePath: string;
  text: string | null;
  fontFile: string;
  workDir: string;
}): Promise<string> {
  const base = opts.baseFramePath;
  const output = path.join(opts.workDir, "thumbnail.jpg");
  const filters = ["scale=1080:1920", "eq=contrast=1.08:saturation=1.15"];
  if (opts.text && opts.text.trim()) {
    const language = analyzeLanguage(opts.text, "thumbnail");
    if (!language.isEnglish) throw new LanguageValidationError("thumbnail text", language.reasons);
    const lines = wrapThumbnailText(opts.text);
    const fontSize = lines.some((l) => l.length > 9) ? 120 : 150;
    lines.forEach((line, i) => {
      const file = path.join(opts.workDir, `thumb-line-${i}.txt`);
      filters.push(
        `drawtext=fontfile='${escapeFilterPath(opts.fontFile)}':textfile='${escapeFilterPath(file)}':fontsize=${fontSize}:fontcolor=white:` +
          `borderw=10:bordercolor=black:shadowx=4:shadowy=4:shadowcolor=black@0.6:x=(w-text_w)/2:y=${360 + i * (fontSize + 30)}`,
      );
    });
    await Promise.all(lines.map((line, i) => writeFile(path.join(opts.workDir, `thumb-line-${i}.txt`), line)));
  }
  await ffmpeg(["-i", base, "-vf", filters.join(","), "-frames:v", "1", "-q:v", "2", output], { timeoutMs: 60_000 });
  return output;
}
