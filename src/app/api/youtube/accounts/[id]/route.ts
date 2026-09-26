import type { NextRequest } from "next/server";
import { z } from "zod";
import { authedRoute, json, parseBody } from "@/lib/api";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { disconnectAccount } from "@/services/youtube/youtube-service";

type Ctx = RouteContext<"/api/youtube/accounts/[id]">;

export const PATCH = authedRoute<Ctx>(async (req: NextRequest, { user, params }) => {
  const { id } = await params;
  await parseBody(req, z.object({ isDefault: z.literal(true) }));
  const account = await db.youTubeAccount.findFirst({ where: { id, userId: user.id } });
  if (!account) throw new NotFoundError("YouTube account", id);
  await db.$transaction([
    db.youTubeAccount.updateMany({ where: { userId: user.id }, data: { isDefault: false } }),
    db.youTubeAccount.update({ where: { id }, data: { isDefault: true } }),
  ]);
  return json({ ok: true });
});

export const DELETE = authedRoute<Ctx>(async (_req, { user, params }) => {
  const { id } = await params;
  await disconnectAccount(user.id, id);
  return json({ ok: true });
});
