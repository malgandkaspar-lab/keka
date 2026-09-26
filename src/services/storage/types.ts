import type { Readable } from "node:stream";

/**
 * StorageProvider
 *
 * Purpose: persist binary media (voiceovers, footage, renders, thumbnails) behind an
 * abstraction so business logic never depends on local filesystem paths.
 * Providers: LocalStorageProvider (development), S3StorageProvider (production,
 * any S3-compatible service such as AWS S3, Cloudflare R2, MinIO, Backblaze B2).
 *
 * Keys are POSIX-style relative paths, e.g. "videos/<id>/voice/<hash>.mp3".
 */
export interface StoredObjectInfo {
  key: string;
  sizeBytes: number;
  contentType?: string;
}

export interface StorageProvider {
  readonly name: "local" | "s3";
  upload(key: string, data: Buffer | Readable, contentType: string): Promise<StoredObjectInfo>;
  /** Upload a file from local disk (efficient streaming for large renders). */
  uploadFile(key: string, filePath: string, contentType: string): Promise<StoredObjectInfo>;
  download(key: string): Promise<Buffer>;
  /** Materialise an object on local disk (needed by FFmpeg). Returns the local path. */
  downloadToFile(key: string, destinationPath: string): Promise<string>;
  createReadStream(key: string, range?: { start: number; end: number }): Promise<Readable>;
  stat(key: string): Promise<StoredObjectInfo | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** URL the browser can use. Local: authenticated app route. S3: pre-signed URL. */
  getUrl(key: string, options?: { expiresInSec?: number }): Promise<string>;
}

export function assertSafeKey(key: string): void {
  if (!key || key.startsWith("/") || key.includes("..") || key.includes("\\") || key.includes("\0")) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}
