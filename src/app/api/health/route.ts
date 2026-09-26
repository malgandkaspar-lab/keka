import { db } from "@/lib/db";
import { getRedis } from "@/lib/redis";

/** Liveness/readiness probe: checks PostgreSQL and Redis connectivity. */
export async function GET() {
  const checks: Record<string, string> = {};
  try {
    await db.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "error";
  }
  try {
    checks.redis = (await getRedis().ping()) === "PONG" ? "ok" : "error";
  } catch {
    checks.redis = "error";
  }
  const healthy = Object.values(checks).every((v) => v === "ok");
  return Response.json({ status: healthy ? "ok" : "degraded", checks }, { status: healthy ? 200 : 503 });
}
