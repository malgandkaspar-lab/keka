import { authedRoute, json } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { syncVoices } from "@/services/tts/voice-catalog";
import { getUserSettings } from "@/services/settings/settings-service";

/** Imports English-capable voices from the TTS provider account. */
export const POST = authedRoute(async (_req, { user }) => {
  await rateLimit(`voice-sync:${user.id}`, 10, 3600);
  const result = await syncVoices(await getUserSettings(user.id));
  return json(result);
});
