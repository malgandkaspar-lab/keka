import { readFile } from "node:fs/promises";
import type { MediaKind, MediaSource, Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { getStorage } from "@/services/storage";
import { mediaInfo } from "@/services/video/ffmpeg";

/**
 * MediaService
 *
 * Purpose: store a binary asset in StorageService and record it as a MediaAsset with
 * full provenance (source, source URL, author, license) and technical metadata.
 */
export interface StoreAssetInput {
  userId?: string | null;
  kind: MediaKind;
  key: string;
  mimeType: string;
  source: MediaSource;
  data?: Buffer;
  filePath?: string;
  sourceId?: string | null;
  sourceUrl?: string | null;
  author?: string | null;
  authorUrl?: string | null;
  license?: string | null;
  licenseUrl?: string | null;
  metadata?: Prisma.InputJsonValue;
  /** Probe with ffprobe to record duration/resolution (audio/video only). */
  probe?: boolean;
}

export async function storeAsset(input: StoreAssetInput) {
  const storage = getStorage();
  if (!input.data && !input.filePath) throw new Error("storeAsset requires data or filePath");
  const buffer = input.data ?? (await readFile(input.filePath!));
  const info = input.filePath
    ? await storage.uploadFile(input.key, input.filePath, input.mimeType)
    : await storage.upload(input.key, buffer, input.mimeType);

  let technical: { durationSec?: number; width?: number; height?: number; fps?: number } = {};
  if (input.probe && input.filePath) {
    const probed = await mediaInfo(input.filePath);
    technical = { durationSec: probed.durationSec, width: probed.width, height: probed.height, fps: probed.fps };
  }

  return db.mediaAsset.upsert({
    where: { storageKey: input.key },
    create: {
      userId: input.userId ?? null,
      kind: input.kind,
      storageKey: input.key,
      mimeType: input.mimeType,
      sizeBytes: BigInt(info.sizeBytes),
      source: input.source,
      sourceId: input.sourceId ?? null,
      sourceUrl: input.sourceUrl ?? null,
      author: input.author ?? null,
      authorUrl: input.authorUrl ?? null,
      license: input.license ?? null,
      licenseUrl: input.licenseUrl ?? null,
      checksum: sha256(buffer),
      metadata: input.metadata ?? {},
      ...technical,
    },
    update: {
      sizeBytes: BigInt(info.sizeBytes),
      checksum: sha256(buffer),
      mimeType: input.mimeType,
      ...technical,
    },
  });
}

export async function assetUrl(assetId: string | null | undefined): Promise<string | null> {
  if (!assetId) return null;
  const asset = await db.mediaAsset.findUnique({ where: { id: assetId } });
  if (!asset) return null;
  return getStorage().getUrl(asset.storageKey);
}
