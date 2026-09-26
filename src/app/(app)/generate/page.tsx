import { GenerateForm } from "@/components/forms/generate-form";
import { PageHeader } from "@/components/ui/primitives";
import { credentialStatus } from "@/config/env";
import { requirePageUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { MOOD_PROFILES } from "@/services/music/procedural";
import { getUserSettings } from "@/services/settings/settings-service";

export const metadata = { title: "Generate" };

export default async function GeneratePage() {
  const user = await requirePageUser();
  const settings = await getUserSettings(user.id);
  const [categories, voices, templates, youtubeAccounts] = await Promise.all([
    db.topicCategory.findMany({ where: { enabled: true }, orderBy: { sortOrder: "asc" } }),
    db.voicePreset.findMany({ where: { enabled: true, language: "en" }, orderBy: { name: "asc" } }),
    db.generationTemplate.findMany({ where: { enabled: true }, orderBy: { createdAt: "asc" } }),
    db.youTubeAccount.count({ where: { userId: user.id, status: "ACTIVE" } }),
  ]);
  const creds = credentialStatus();
  const missing = [
    !creds.anthropic && "ANTHROPIC_API_KEY",
    !creds.elevenlabs && "ELEVENLABS_API_KEY",
    !creds.pexels && "PEXELS_API_KEY",
  ].filter((v): v is string => Boolean(v));

  return (
    <>
      <PageHeader title="Generate a Short" description="Enter a topic or let the AI choose one. The whole pipeline runs automatically." />
      <GenerateForm
        options={{
          categories: categories.map((c) => ({ key: c.key, name: c.name })),
          voices: voices.map((v) => ({ id: v.id, name: v.name, description: v.description, gender: v.gender })),
          templates: templates.map((t) => ({ key: t.key, name: t.name, description: t.description })),
          moods: Object.keys(MOOD_PROFILES),
          durations: settings.durationPresets,
          youtubeConnected: youtubeAccounts > 0,
          defaults: {
            category: settings.defaultCategory,
            durationSec: settings.defaultDurationSec,
            voicePresetId: settings.defaultVoicePresetId,
            templateKey: settings.defaultTemplateKey,
            musicMode: settings.defaultMusicMode,
            privacy: settings.defaultPrivacy,
            autoPublish: settings.autoPublish,
          },
          missingCredentials: missing,
        }}
      />
    </>
  );
}
