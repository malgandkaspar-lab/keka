import type { NextRequest } from "next/server";
import { authedRoute, json } from "@/lib/api";
import { deleteVideo, editComponents, editMetadata } from "@/services/videos/manual-edits";
import { videoDetails } from "@/services/videos/video-details";

type Ctx = RouteContext<"/api/videos/[id]">;

export const GET = authedRoute<Ctx>(async (_req, { user, params }) => {
  const { id } = await params;
  const details = await videoDetails(user.id, id);
  return json(JSON.parse(JSON.stringify(details, (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v))));
});

/** Body: { metadata?: {...} } and/or component changes (voice, music, privacy). */
export const PATCH = authedRoute<Ctx>(async (req: NextRequest, { user, params }) => {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { metadata?: unknown } & Record<string, unknown>;
  const { metadata, ...components } = body;
  if (metadata) await editMetadata(user.id, id, metadata);
  if (Object.keys(components).length) await editComponents(user.id, id, components);
  return json({ ok: true });
});

export const DELETE = authedRoute<Ctx>(async (_req, { user, params }) => {
  const { id } = await params;
  await deleteVideo(user.id, id);
  return json({ ok: true });
});
