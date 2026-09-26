import type { NextRequest } from "next/server";
import { authedRoute, json } from "@/lib/api";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { computeNextRun, saveSchedule } from "@/services/publishing/scheduler-service";

type Ctx = RouteContext<"/api/schedules/[id]">;

/** Full update (same body as create) or `{ enabled }` toggle. */
export const PATCH = authedRoute<Ctx>(async (req: NextRequest, { user, params }) => {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (Object.keys(body).length === 1 && typeof body.enabled === "boolean") {
    const existing = await db.schedule.findFirst({ where: { id, userId: user.id } });
    if (!existing) throw new NotFoundError("Schedule", id);
    const schedule = await db.schedule.update({ where: { id }, data: { enabled: body.enabled, nextRunAt: body.enabled ? computeNextRun(existing) : null } });
    return json({ schedule });
  }
  return json({ schedule: await saveSchedule(user.id, body, id) });
});

export const DELETE = authedRoute<Ctx>(async (_req, { user, params }) => {
  const { id } = await params;
  const res = await db.schedule.deleteMany({ where: { id, userId: user.id } });
  if (res.count === 0) throw new NotFoundError("Schedule", id);
  return json({ ok: true });
});
