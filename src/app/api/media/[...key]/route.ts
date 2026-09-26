import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { getStorage, S3StorageProvider } from "@/services/storage";

/**
 * Authenticated media delivery with HTTP Range support (for the native <video> player).
 * Private assets (renders, voiceovers, thumbnails, subtitles) are only served to their
 * owner; shared licensed stock media and generated music/SFX to any signed-in user.
 * With S3 storage, the browser is redirected to a short-lived pre-signed URL.
 */
const SHARED_SOURCES = new Set(["PEXELS", "GENERATED", "LOCAL_LIBRARY"]);

export async function GET(req: NextRequest, ctx: RouteContext<"/api/media/[...key]">) {
  try {
    const user = await requireUser();
    const { key: parts } = await ctx.params;
    const key = parts.map(decodeURIComponent).join("/");
    const asset = await db.mediaAsset.findUnique({ where: { storageKey: key } });
    if (!asset) throw new NotFoundError("Media");
    if (!SHARED_SOURCES.has(asset.source) && asset.userId !== user.id) throw new ForbiddenError();

    const storage = getStorage();
    if (storage instanceof S3StorageProvider) {
      return Response.redirect(await storage.getUrl(key, { expiresInSec: 900 }), 302);
    }
    const info = await storage.stat(key);
    if (!info) throw new NotFoundError("Media file");
    const size = info.sizeBytes;
    const headers: Record<string, string> = {
      "content-type": asset.mimeType,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    };

    const range = req.headers.get("range");
    const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (match && (match[1] || match[2])) {
      let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      let end = match[1] && match[2] ? Number(match[2]) : size - 1;
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      }
      end = Math.min(end, size - 1);
      start = Math.max(0, start);
      const stream = await storage.createReadStream(key, { start, end });
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
      });
    }
    const stream = await storage.createReadStream(key);
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers: { ...headers, "content-length": String(size) } });
  } catch (error) {
    return errorResponse(error);
  }
}
