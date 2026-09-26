import type { NextRequest } from "next/server";
import { z } from "zod";
import { authedRoute, json, parseBody } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { replaceSceneFootage, searchSceneReplacement } from "@/services/videos/manual-edits";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("search"), query: z.string().min(2).max(80) }),
  z.object({ action: z.literal("select"), candidateId: z.string().min(1).max(100) }),
]);

/** Scene editor: search replacement footage or choose a candidate. */
export const POST = authedRoute<RouteContext<"/api/videos/[id]/scenes/[sceneId]">>(async (req: NextRequest, { user, params }) => {
  const { id, sceneId } = await params;
  const body = await parseBody(req, bodySchema);
  if (body.action === "search") {
    await rateLimit(`footage-search:${user.id}`, 60, 3600);
    const candidates = await searchSceneReplacement(user.id, id, sceneId, body.query);
    return json({ candidates });
  }
  await replaceSceneFootage(user.id, id, sceneId, body.candidateId);
  return json({ ok: true });
});
