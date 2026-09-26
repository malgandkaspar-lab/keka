import type { NextRequest } from "next/server";
import { z } from "zod";
import { authedRoute, json, parseBody } from "@/lib/api";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";

type Ctx = RouteContext<"/api/music/[id]">;

export const PATCH = authedRoute<Ctx>(async (req: NextRequest, { user, params }) => {
  const { id } = await params;
  const body = await parseBody(req, z.object({ enabled: z.boolean() }));
  const track = await db.musicTrack.findFirst({ where: { id, OR: [{ userId: user.id }, { userId: null, source: "GENERATED" }] } });
  if (!track) throw new NotFoundError("Music track", id);
  return json({ track: await db.musicTrack.update({ where: { id }, data: { enabled: body.enabled } }) });
});
