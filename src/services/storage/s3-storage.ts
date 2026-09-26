import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ExternalServiceError } from "@/lib/errors";
import { assertSafeKey, type StorageProvider, type StoredObjectInfo } from "./types";

export interface S3StorageConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** S3-compatible object storage for production. */
export class S3StorageProvider implements StorageProvider {
  readonly name = "s3" as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3StorageConfig, client?: S3Client) {
    this.bucket = config.bucket;
    this.client =
      client ??
      new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        maxAttempts: 4,
      });
  }

  private wrap(operation: string, error: unknown): never {
    throw new ExternalServiceError("s3", `${operation} failed: ${(error as Error).message}`, {
      retryable: true,
      cause: error,
    });
  }

  async upload(key: string, data: Buffer | Readable, contentType: string): Promise<StoredObjectInfo> {
    assertSafeKey(key);
    const body = Buffer.isBuffer(data) ? data : Buffer.concat(await Array.fromAsync(data as AsyncIterable<Buffer>));
    try {
      await this.client.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
      );
    } catch (error) {
      this.wrap("upload", error);
    }
    return { key, sizeBytes: body.length, contentType };
  }

  async uploadFile(key: string, filePath: string, contentType: string): Promise<StoredObjectInfo> {
    assertSafeKey(key);
    const info = await stat(filePath);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: createReadStream(filePath),
          ContentType: contentType,
          ContentLength: info.size,
        }),
      );
    } catch (error) {
      this.wrap("uploadFile", error);
    }
    return { key, sizeBytes: info.size, contentType };
  }

  private async getBody(key: string, range?: string): Promise<Readable> {
    assertSafeKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }));
      if (!res.Body) throw new Error("empty body");
      return res.Body as Readable;
    } catch (error) {
      this.wrap("download", error);
    }
  }

  async download(key: string): Promise<Buffer> {
    const body = await this.getBody(key);
    return Buffer.concat(await Array.fromAsync(body as AsyncIterable<Buffer>));
  }

  async downloadToFile(key: string, destinationPath: string): Promise<string> {
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await pipeline(await this.getBody(key), createWriteStream(destinationPath));
    return destinationPath;
  }

  async createReadStream(key: string, range?: { start: number; end: number }): Promise<Readable> {
    return this.getBody(key, range ? `bytes=${range.start}-${range.end}` : undefined);
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    assertSafeKey(key);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { key, sizeBytes: res.ContentLength ?? 0, contentType: res.ContentType };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      this.wrap("stat", error);
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      this.wrap("delete", error);
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async getUrl(key: string, options: { expiresInSec?: number } = {}): Promise<string> {
    assertSafeKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: options.expiresInSec ?? 3600,
    });
  }
}

