import type { NextRequest } from "next/server";
import { z } from "zod";
import { authedRoute, json, parseBody } from "@/lib/api";
import { editScript } from "@/services/videos/manual-edits";

export const PUT = authedRoute<RouteContext<"/api/videos/[id]/script">>(async (req: NextRequest, { user, params }) => {
  const { id } = await params;
  const { text } = await parseBody(req, z.object({ text: z.string().min(1).max(10_000) }));
  await editScript(user.id, id, text);
  return json({ ok: true });
});
