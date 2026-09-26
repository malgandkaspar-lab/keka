import type { NextRequest } from "next/server";
import { SUBTITLE_STYLE_PRESETS } from "@/config/templates";
import { authedRoute, json } from "@/lib/api";
import { deleteCustomSubtitleStyle, listCustomSubtitleStyles, saveCustomSubtitleStyle } from "@/services/subtitles/style-service";

export const GET = authedRoute(async (_req, { user }) => json({ presets: Object.values(SUBTITLE_STYLE_PRESETS), custom: await listCustomSubtitleStyles(user.id) }));

export const POST = authedRoute(async (req: NextRequest, { user }) => {
  const style = await saveCustomSubtitleStyle(user.id, await req.json().catch(() => ({})));
  return json({ style }, { status: 201 });
});

export const DELETE = authedRoute(async (req: NextRequest, { user }) => {
  const key = req.nextUrl.searchParams.get("key");
  if (key) await deleteCustomSubtitleStyle(user.id, key);
  return json({ ok: true });
});
