import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, rm, stat, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomToken } from "@/lib/crypto";
import { assertSafeKey, type StorageProvider, type StoredObjectInfo } from "./types";

/** Local filesystem storage for development and single-node deployments. */
export class LocalStorageProvider implements StorageProvider {
  readonly name = "local" as const;
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  private resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error(`Storage key escapes root: ${key}`);
    return full;
  }

  async upload(key: string, data: Buffer | Readable, _contentType: string): Promise<StoredObjectInfo> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    // Write to a temp file then rename, so readers never see partial files.
    const tmp = `${target}.${randomToken(6)}.part`;
    const source = Buffer.isBuffer(data) ? Readable.from(data) : data;
    await pipeline(source, createWriteStream(tmp));
    await rename(tmp, target);
    const info = await stat(target);
    return { key, sizeBytes: info.size };
  }

  async uploadFile(key: string, filePath: string, _contentType: string): Promise<StoredObjectInfo> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${randomToken(6)}.part`;
    await copyFile(filePath, tmp);
    await rename(tmp, target);
    const info = await stat(target);
    return { key, sizeBytes: info.size };
  }

  async download(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async downloadToFile(key: string, destinationPath: string): Promise<string> {
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(this.resolve(key), destinationPath);
    return destinationPath;
  }

  /** Local-only optimisation: the on-disk path, so FFmpeg can read without copying. */
  localPath(key: string): string {
    return this.resolve(key);
  }

  async createReadStream(key: string, range?: { start: number; end: number }): Promise<Readable> {
    return createReadStream(this.resolve(key), range ? { start: range.start, end: range.end } : undefined);
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    try {
      const info = await stat(this.resolve(key));
      return info.isFile() ? { key, sizeBytes: info.size } : null;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async getUrl(key: string): Promise<string> {
    assertSafeKey(key);
    return `/api/media/${key.split("/").map(encodeURIComponent).join("/")}`;
  }
}
