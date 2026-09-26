import { getRedis } from "@/lib/redis";
import { LimitExceededError } from "@/lib/errors";

/**
 * Fixed-window rate limiter backed by Redis.
 * Used for login attempts and expensive API endpoints.
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<{ remaining: number }> {
  const redis = getRedis();
  const bucket = `ratelimit:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const count = await redis.incr(bucket);
  if (count === 1) await redis.expire(bucket, windowSec);
  if (count > limit) {
    throw new LimitExceededError("Too many requests, please slow down.", { key, limit, windowSec });
  }
  return { remaining: limit - count };
}
