import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { NextRequest } from "next/server";
import { authedRoute, json } from "@/lib/api";
import { stableHash } from "@/lib/crypto";
import { db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { withWorkDir } from "@/lib/workdir";
import { storeAsset } from "@/services/media/media-service";
import { MOOD_PROFILES } from "@/services/music/procedural";
import { mediaInfo } from "@/services/video/ffmpeg";

const MAX_BYTES = 50 * 1024 * 1024;
const AUDIO_TYPES: Record<string, string> = { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac" };

export const GET = authedRoute(async (_req, { user }) => {
  const tracks = await db.musicTrack.findMany({ where: { OR: [{ userId: user.id }, { userId: null }] }, orderBy: { createdAt: "desc" } });
  return json({ tracks });
});

/**
 * Uploads a royalty-free / licensed music track to the user's library. The license is
 * mandatory so every track used in a video has documented rights.
 */
export const POST = authedRoute(async (req: NextRequest, { user }) => {
  const form = await req.formData();
  const file = form.get("file");
  const title = String(form.get("title") ?? "").trim();
  const license = String(form.get("license") ?? "").trim();
  const moods = String(form.get("moods") ?? "").split(",").map((m) => m.trim().toLowerCase()).filter((m) => MOOD_PROFILES[m]);
  if (!(file instanceof File)) throw new ValidationError("Choose an audio file");
  if (!title) throw new ValidationError("Title is required");
  if (license.length < 3) throw new ValidationError("License information is required (e.g. 'CC BY 4.0' or 'Purchased license #123')");
  if (moods.length === 0) throw new ValidationError(`Choose at least one mood: ${Object.keys(MOOD_PROFILES).join(", ")}`);
  const extension = AUDIO_TYPES[file.type];
  if (!extension) throw new ValidationError(`Unsupported audio type ${file.type || "(unknown)"}`);
  if (file.size > MAX_BYTES) throw new ValidationError("File is larger than 50 MB");

  const buffer = Buffer.from(await file.arrayBuffer());
  const track = await withWorkDir("music-upload", async (dir) => {
    const local = path.join(dir, `upload.${extension}`);
    await writeFile(local, buffer);
    const info = await mediaInfo(local).catch(() => null);
    if (!info?.hasAudio || info.durationSec < 10) throw new ValidationError("The file is not a readable audio track of at least 10 seconds");
    const asset = await storeAsset({
      userId: user.id,
      kind: "AUDIO_MUSIC",
      key: `music/library/${user.id}/${stableHash(buffer.toString("base64")).slice(0, 24)}.${extension}`,
      mimeType: file.type,
      source: "LOCAL_LIBRARY",
      filePath: local,
      probe: true,
      author: String(form.get("artist") ?? "") || null,
      license,
      licenseUrl: String(form.get("licenseUrl") ?? "") || null,
    });
    return db.musicTrack.create({
      data: {
        userId: user.id,
        title,
        artist: String(form.get("artist") ?? "") || null,
        moods,
        durationSec: info.durationSec,
        assetId: asset.id,
        source: "LOCAL_LIBRARY",
        license,
        licenseUrl: String(form.get("licenseUrl") ?? "") || null,
        attribution: String(form.get("attribution") ?? "") || null,
      },
    });
  });
  return json({ track }, { status: 201 });
});
