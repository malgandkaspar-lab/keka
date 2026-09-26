import { db } from "@/lib/db";
import type { UserSettings } from "@/services/settings/schema";
import { getTTSProvider } from "./index";

/**
 * Voice catalogue sync: imports English-capable voices from the TTS provider account
 * into VoicePreset (voice IDs are data, never hard-coded business logic).
 */
export async function syncVoices(settings: Pick<UserSettings, "ttsProvider">): Promise<{ imported: number; skippedNonEnglish: number }> {
  const provider = getTTSProvider(settings);
  const voices = await provider.listVoices();
  let imported = 0;
  let skippedNonEnglish = 0;
  for (const voice of voices) {
    if (!voice.englishCapable) {
      skippedNonEnglish++;
      continue;
    }
    await db.voicePreset.upsert({
      where: { provider_voiceId: { provider: provider.name, voiceId: voice.voiceId } },
      create: {
        provider: provider.name,
        voiceId: voice.voiceId,
        name: voice.name,
        description: [voice.description, voice.accent].filter(Boolean).join(" · ") || null,
        gender: voice.gender ?? null,
        styles: voice.styles,
        previewUrl: voice.previewUrl ?? null,
        language: "en",
      },
      update: { name: voice.name, previewUrl: voice.previewUrl ?? null, styles: voice.styles },
    });
    imported++;
  }
  return { imported, skippedNonEnglish };
}
