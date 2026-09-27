import { IntegrationStatus, LocalAiStatusCard, MusicLibrary, SettingsForm, VoiceSync } from "@/components/forms/settings-form";
import { localAiStatus } from "@/services/local-ai/status";
import { SubtitleStyleEditor } from "@/components/forms/subtitle-style-editor";
import { listCustomSubtitleStyles, SUBTITLE_FONTS } from "@/services/subtitles/style-service";
import { PageHeader } from "@/components/ui/primitives";
import { credentialStatus } from "@/config/env";
import { CLAUDE_TEXT_MODELS } from "@/services/ai/anthropic-provider";
import { SUBTITLE_STYLE_PRESETS } from "@/config/templates";
import { requirePageUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { MOOD_PROFILES } from "@/services/music/procedural";
import { getUserSettings } from "@/services/settings/settings-service";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await requirePageUser();
  const [settings, categories, voices, templates, tracks, customStyles] = await Promise.all([
    getUserSettings(user.id),
    db.topicCategory.findMany({ where: { enabled: true }, orderBy: { sortOrder: "asc" } }),
    db.voicePreset.findMany({ where: { enabled: true, language: "en" }, orderBy: [{ provider: "desc" }, { name: "asc" }] }),
    db.generationTemplate.findMany({ where: { enabled: true } }),
    db.musicTrack.findMany({ where: { OR: [{ userId: user.id }, { userId: null }] }, orderBy: { createdAt: "desc" } }),
    listCustomSubtitleStyles(user.id),
  ]);

  return (
    <>
      <PageHeader title="Settings" description="Defaults, limits, providers and libraries. English is the only supported content language." />
      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="space-y-6">
        <SettingsForm
          settings={settings}
          options={{
            categories: categories.map((c) => ({ key: c.key, name: c.name })),
            voices: voices.map((v) => ({ id: v.id, name: `${v.name} (${v.provider === "kokoro" ? "Kokoro, free" : "ElevenLabs"})` })),
            templates: templates.map((t) => ({ key: t.key, name: t.name })),
            subtitleStyles: [...Object.values(SUBTITLE_STYLE_PRESETS), ...customStyles].map((s) => ({ key: s.key, name: s.name })),
            moods: Object.keys(MOOD_PROFILES),
            aiModels: [...CLAUDE_TEXT_MODELS],
          }}
        />
        <SubtitleStyleEditor fonts={SUBTITLE_FONTS} custom={customStyles} base={SUBTITLE_STYLE_PRESETS.fast_viral!} />
        </div>
        <div className="space-y-6">
          <LocalAiStatusCard status={await localAiStatus(settings.ollamaModel)} />
          <IntegrationStatus status={credentialStatus()} />
          <VoiceSync count={voices.length} />
          <MusicLibrary
            moods={Object.keys(MOOD_PROFILES)}
            tracks={tracks.map((t) => ({ id: t.id, title: t.title, moods: t.moods, license: t.license, source: t.source, enabled: t.enabled, durationSec: t.durationSec }))}
          />
        </div>
      </div>
    </>
  );
}
