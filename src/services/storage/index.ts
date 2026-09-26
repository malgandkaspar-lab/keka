import path from "node:path";
import { getEnv, requireCredential } from "@/config/env";
import { LocalStorageProvider } from "./local-storage";
import { S3StorageProvider } from "./s3-storage";
import type { StorageProvider } from "./types";

/**
 * StorageService entry point.
 *
 * Configuration: STORAGE_DRIVER=local|s3 (+ STORAGE_* variables for S3).
 * Example:
 *   const storage = getStorage();
 *   await storage.upload("videos/123/voice.mp3", buffer, "audio/mpeg");
 *   const url = await storage.getUrl("videos/123/voice.mp3");
 */
let instance: StorageProvider | undefined;

export function getStorage(): StorageProvider {
  if (instance) return instance;
  const env = getEnv();
  if (env.STORAGE_DRIVER === "s3") {
    instance = new S3StorageProvider({
      bucket: requireCredential("STORAGE_BUCKET"),
      accessKeyId: requireCredential("STORAGE_ACCESS_KEY"),
      secretAccessKey: requireCredential("STORAGE_SECRET_KEY"),
      region: env.STORAGE_REGION,
      endpoint: env.STORAGE_ENDPOINT,
      forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
    });
  } else {
    instance = new LocalStorageProvider(path.resolve(env.STORAGE_LOCAL_DIR, "objects"));
  }
  return instance;
}

export function setStorageForTesting(provider: StorageProvider | undefined): void {
  instance = provider;
}

/**
 * Returns a local file path for an object, downloading it into `workDir` when the
 * provider is remote. FFmpeg needs local files.
 */
export async function materialize(key: string, workDir: string): Promise<string> {
  const storage = getStorage();
  if (storage instanceof LocalStorageProvider) return storage.localPath(key);
  const destination = path.join(workDir, "inputs", key.replaceAll("/", "__"));
  return storage.downloadToFile(key, destination);
}

export { LocalStorageProvider, S3StorageProvider };
export type { StorageProvider };
