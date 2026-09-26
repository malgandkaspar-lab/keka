import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "@/config/env";
import { randomToken } from "@/lib/crypto";

/** Scratch directories for media processing; always cleaned up after use. */
export async function withWorkDir<T>(label: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = path.resolve(getEnv().WORK_DIR, `${label}-${Date.now()}-${randomToken(4)}`);
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
