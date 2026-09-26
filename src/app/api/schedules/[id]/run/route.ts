import { authedRoute, json } from "@/lib/api";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { runSchedule } from "@/services/publishing/scheduler-service";

/** Runs a schedule immediately (creates its videos and starts their pipelines). */
export const POST = authedRoute<RouteContext<"/api/schedules/[id]/run">>(async (_req, { user, params }) => {
  const { id } = await params;
  const schedule = await db.schedule.findFirst({ where: { id, userId: user.id } });
  if (!schedule) throw new NotFoundError("Schedule", id);
  const result = await runSchedule(schedule);
  await db.schedule.update({ where: { id }, data: { lastRunAt: new Date() } });
  return json(result);
});
