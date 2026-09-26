import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

/**
 * Persistent response cache (Postgres `ApiCache` table) used to avoid paying twice for
 * identical external lookups: research, footage searches, voice lists.
 */
export async function getCached<T>(key: string): Promise<T | null> {
  const row = await db.apiCache.findUnique({ where: { key } });
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.apiCache.delete({ where: { key } }).catch(() => undefined);
    return null;
  }
  return row.value as T;
}

export async function setCached(key: string, namespace: string, value: unknown, ttlSec: number): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlSec * 1000);
  const json = JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  await db.apiCache.upsert({
    where: { key },
    create: { key, namespace, value: json, expiresAt },
    update: { value: json, expiresAt },
  });
}

export async function purgeExpiredCache(): Promise<number> {
  const res = await db.apiCache.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return res.count;
}
