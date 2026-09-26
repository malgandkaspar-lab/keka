import type { NextRequest } from "next/server";
import { authedRoute, json } from "@/lib/api";
import { getUserSettings, updateUserSettings } from "@/services/settings/settings-service";

export const GET = authedRoute(async (_req, { user }) => json({ settings: await getUserSettings(user.id) }));

export const PATCH = authedRoute(async (req: NextRequest, { user }) => {
  const settings = await updateUserSettings(user.id, await req.json().catch(() => ({})));
  return json({ settings });
});
