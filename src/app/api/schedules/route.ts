import type { NextRequest } from "next/server";
import { authedRoute, json } from "@/lib/api";
import { db } from "@/lib/db";
import { saveSchedule } from "@/services/publishing/scheduler-service";

export const GET = authedRoute(async (_req, { user }) => {
  const schedules = await db.schedule.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" }, include: { template: { select: { key: true, name: true } } } });
  return json({ schedules });
});

export const POST = authedRoute(async (req: NextRequest, { user }) => {
  const schedule = await saveSchedule(user.id, await req.json().catch(() => ({})));
  return json({ schedule }, { status: 201 });
});
