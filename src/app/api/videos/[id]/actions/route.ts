import type { NextRequest } from "next/server";
import { z } from "zod";
import { authedRoute, json, parseBody } from "@/lib/api";
import { getOwnedVideo } from "@/services/videos/video-service";
import { cancel, regenerate, requestPublish, startOrResume } from "@/services/pipeline/orchestrator";
import { REGENERATION_TARGETS } from "@/services/pipeline/steps";
import { getUserSettings } from "@/services/settings/settings-service";
import { assertWithinLimits } from "@/services/cost/limits-service";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("publish") }),
  z.object({ action: z.literal("regenerate"), target: z.enum(Object.keys(REGENERATION_TARGETS) as [keyof typeof REGENERATION_TARGETS, ...(keyof typeof REGENERATION_TARGETS)[]]) }),
]);

/** Pipeline control: cancel, resume/retry, regenerate a component, publish. */
export const POST = authedRoute<RouteContext<"/api/videos/[id]/actions">>(async (req: NextRequest, { user, params }) => {
  const { id } = await params;
  const video = await getOwnedVideo(user.id, id);
  const body = await parseBody(req, actionSchema);
  switch (body.action) {
    case "cancel":
      await cancel(video.id);
      break;
    case "resume":
      await startOrResume(video.id);
      break;
    case "publish":
      await requestPublish(video.id);
      break;
    case "regenerate": {
      if (body.target === "all") await assertWithinLimits(user.id, await getUserSettings(user.id), 0);
      await regenerate(video.id, REGENERATION_TARGETS[body.target]);
      break;
    }
  }
  return json({ ok: true });
});
