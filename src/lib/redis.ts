import { Redis, type RedisOptions } from "ioredis";

/**
 * Redis connections. BullMQ requires `maxRetriesPerRequest: null` on connections
 * used by workers, so every connection created here is BullMQ-compatible.
 */
const globalForRedis = globalThis as unknown as { __redis?: Redis };

export function redisOptions(): RedisOptions {
  return { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false };
}

export function createRedisConnection(): Redis {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  return new Redis(url, redisOptions());
}

/** Shared connection for non-blocking commands (rate limiting, cancellation flags). */
export function getRedis(): Redis {
  if (!globalForRedis.__redis) globalForRedis.__redis = createRedisConnection();
  return globalForRedis.__redis;
}

export async function closeRedis(): Promise<void> {
  if (globalForRedis.__redis) {
    await globalForRedis.__redis.quit();
    globalForRedis.__redis = undefined;
  }
}
