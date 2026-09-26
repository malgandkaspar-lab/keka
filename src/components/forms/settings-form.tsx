"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { Alert, Badge, Button, Card, CardTitle, Input, Label, Select } from "@/components/ui/primitives";
import { api, ApiClientError } from "@/lib/client-api";
import { useAction } from "@/components/videos/video-actions";
import type { UserSettings } from "@/services/settings/schema";

interface Options {
  categories: { key: string; name: string }[];
  voices: { id: string; name: string }[];
  templates: { key: string; name: string }[];
  subtitleStyles: { key: string; name: string }[];
  moods: string[];
  aiModels: string[];
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <Label hint={hint}>{label}</Label>
      {children}
    </div>
  );
}

export function SettingsForm({ settings, options }: { settings: UserSettings; options: Options }) {
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const num = (k: string) => Number(f.get(k));
    const body: Partial<UserSettings> = {
      defaultCategory: String(f.get("defaultCategory")),
      defaultDurationSec: num("defaultDurationSec"),
      defaultVoicePresetId: (f.get("defaultVoicePresetId") as string) || null,
      defaultTemplateKey: String(f.get("defaultTemplateKey")),
      defaultMusicMode: String(f.get("defaultMusicMode")),
      subtitleStyleKey: (f.get("subtitleStyleKey") as string) || null,
      defaultPrivacy: f.get("defaultPrivacy") as UserSettings["defaultPrivacy"],
      autoPublish: f.get("autoPublish") === "on",
      dailyGenerationLimit: num("dailyGenerationLimit"),
      monthlyGenerationLimit: num("monthlyGenerationLimit"),
      monthlyBudgetUsd: num("monthlyBudgetUsd"),
      aiModel: String(f.get("aiModel")),
      aiEffort: f.get("aiEffort") as UserSettings["aiEffort"],
      ttsModelId: String(f.get("ttsModelId")),
      sttProvider: f.get("sttProvider") as UserSettings["sttProvider"],
      wordsPerMinute: num("wordsPerMinute"),
      musicVolume: num("musicVolume") / 100,
      sfxEnabled: f.get("sfxEnabled") === "on",
      researchEnabled: f.get("researchEnabled") === "on",
      imageFallbackEnabled: f.get("imageFallbackEnabled") === "on",
      youtubeCategoryId: String(f.get("youtubeCategoryId")),
    };
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/settings", { method: "PATCH", json: body });
      setMessage({ tone: "success", text: "Settings saved." });
    } catch (err) {
      setMessage({ tone: "danger", text: err instanceof ApiClientError ? err.message : "Could not save settings" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <Card>
        <CardTitle>Defaults for new videos</CardTitle>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Category">
            <Select name="defaultCategory" defaultValue={settings.defaultCategory}>
              {options.categories.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Duration (seconds)">
            <Input name="defaultDurationSec" type="number" min={10} max={180} defaultValue={settings.defaultDurationSec} />
          </Field>
          <Field label="Voice">
            <Select name="defaultVoicePresetId" defaultValue={settings.defaultVoicePresetId ?? ""}>
              <option value="">First available English voice</option>
              {options.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Video style">
            <Select name="defaultTemplateKey" defaultValue={settings.defaultTemplateKey}>
              {options.templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Music style">
            <Select name="defaultMusicMode" defaultValue={settings.defaultMusicMode}>
              <option value="auto">Automatic</option>
              {options.moods.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value="none">No music</option>
            </Select>
          </Field>
          <Field label="Subtitle style">
            <Select name="subtitleStyleKey" defaultValue={settings.subtitleStyleKey ?? ""}>
              <option value="">Match the video style</option>
              {options.subtitleStyles.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <Card>
        <CardTitle>Publishing</CardTitle>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Default YouTube privacy">
            <Select name="defaultPrivacy" defaultValue={settings.defaultPrivacy}>
              <option value="PRIVATE">Private</option>
              <option value="UNLISTED">Unlisted</option>
              <option value="PUBLIC">Public</option>
              <option value="SCHEDULED">Scheduled</option>
            </Select>
          </Field>
          <Field label="YouTube category ID" hint="27 = Education">
            <Input name="youtubeCategoryId" defaultValue={settings.youtubeCategoryId} />
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" name="autoPublish" defaultChecked={settings.autoPublish} className="accent-indigo-500" />
            Upload automatically when ready
          </label>
        </div>
      </Card>

      <Card>
        <CardTitle>Cost control</CardTitle>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Daily generation limit">
            <Input name="dailyGenerationLimit" type="number" min={0} max={1000} defaultValue={settings.dailyGenerationLimit} />
          </Field>
          <Field label="Monthly generation limit">
            <Input name="monthlyGenerationLimit" type="number" min={0} max={10000} defaultValue={settings.monthlyGenerationLimit} />
          </Field>
          <Field label="Monthly budget (USD, estimated)">
            <Input name="monthlyBudgetUsd" type="number" min={0} step="1" defaultValue={settings.monthlyBudgetUsd} />
          </Field>
        </div>
      </Card>

      <Card>
        <CardTitle>AI, voice & audio</CardTitle>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="AI provider">
            <Select name="aiProvider" defaultValue={settings.aiProvider} disabled>
              <option value="anthropic">Anthropic Claude</option>
            </Select>
          </Field>
          <Field label="AI model">
            <Select name="aiModel" defaultValue={settings.aiModel}>
              {[...new Set([settings.aiModel, ...options.aiModels])].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="AI effort">
            <Select name="aiEffort" defaultValue={settings.aiEffort}>
              <option value="low">Low (cheapest)</option>
              <option value="medium">Medium</option>
              <option value="high">High (best quality)</option>
            </Select>
          </Field>
          <Field label="ElevenLabs model">
            <Select name="ttsModelId" defaultValue={settings.ttsModelId}>
              <option value="eleven_multilingual_v2">eleven_multilingual_v2 (highest quality)</option>
              <option value="eleven_turbo_v2_5">eleven_turbo_v2_5 (fast, English enforced)</option>
              <option value="eleven_flash_v2_5">eleven_flash_v2_5 (fastest, English enforced)</option>
            </Select>
          </Field>
          <Field label="Speech-to-text">
            <Select name="sttProvider" defaultValue={settings.sttProvider}>
              <option value="elevenlabs">ElevenLabs Scribe</option>
              <option value="openai">OpenAI Whisper</option>
            </Select>
          </Field>
          <Field label="Speaking rate (words/min)">
            <Input name="wordsPerMinute" type="number" min={100} max={240} defaultValue={settings.wordsPerMinute} />
          </Field>
          <Field label="Music volume (%)" hint="8-15% recommended">
            <Input name="musicVolume" type="number" min={3} max={25} defaultValue={Math.round(settings.musicVolume * 100)} />
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap gap-6 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="researchEnabled" defaultChecked={settings.researchEnabled} className="accent-indigo-500" /> Research topics before writing (recommended)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="sfxEnabled" defaultChecked={settings.sfxEnabled} className="accent-indigo-500" /> Sound effects
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="imageFallbackEnabled" defaultChecked={settings.imageFallbackEnabled} className="accent-indigo-500" /> Still images with motion as footage fallback
          </label>
        </div>
      </Card>

      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      <Button type="submit" disabled={busy}>
        {busy ? "Saving..." : "Save settings"}
      </Button>
    </form>
  );
}

export function IntegrationStatus({ status }: { status: Record<string, boolean> }) {
  const labels: Record<string, [string, string]> = {
    anthropic: ["Anthropic Claude", "ANTHROPIC_API_KEY"],
    elevenlabs: ["ElevenLabs (voice + subtitles)", "ELEVENLABS_API_KEY"],
    openaiWhisper: ["OpenAI Whisper (optional)", "OPENAI_API_KEY"],
    pexels: ["Pexels stock footage", "PEXELS_API_KEY"],
    youtube: ["YouTube OAuth", "YOUTUBE_CLIENT_ID / SECRET / REDIRECT_URI"],
    s3: ["S3 storage (production)", "STORAGE_* variables"],
  };
  return (
    <Card>
      <CardTitle>Integrations</CardTitle>
      <ul className="space-y-2 text-sm">
        {Object.entries(labels).map(([key, [label, env]]) => (
          <li key={key} className="flex items-center justify-between gap-3">
            <div>
              <p className="text-zinc-200">{label}</p>
              <p className="font-mono text-xs text-zinc-500">{env}</p>
            </div>
            <Badge tone={status[key] ? "success" : "warning"}>{status[key] ? "configured" : "missing"}</Badge>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-zinc-500">Credentials are read from environment variables only and are never sent to the browser.</p>
    </Card>
  );
}

export function VoiceSync({ count }: { count: number }) {
  const { busy, error, run } = useAction();
  const [result, setResult] = useState<string | null>(null);
  return (
    <Card>
      <CardTitle>English voices</CardTitle>
      <p className="text-sm text-zinc-300">{count} English voices available.</p>
      <Button
        className="mt-3"
        variant="secondary"
        size="sm"
        disabled={!!busy}
        onClick={() =>
          run("sync", async () => {
            const res = await api<{ imported: number; skippedNonEnglish: number }>("/api/voices/sync", { method: "POST" });
            setResult(`Imported ${res.imported} English voices (${res.skippedNonEnglish} non-English skipped).`);
          })
        }
      >
        {busy ? "Syncing..." : "Sync voices from ElevenLabs"}
      </Button>
      {result && <p className="mt-2 text-xs text-emerald-300">{result}</p>}
      {error && (
        <div className="mt-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </Card>
  );
}

export function MusicLibrary({ tracks, moods }: { tracks: { id: string; title: string; moods: string[]; license: string; source: string; enabled: boolean; durationSec: number }[]; moods: string[] }) {
  const { busy, error, run } = useAction();
  function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const target = event.currentTarget;
    void run("upload", async () => {
      await api("/api/music", { method: "POST", body: form });
      target.reset();
    });
  }
  return (
    <Card>
      <CardTitle>Music library</CardTitle>
      <p className="mb-3 text-xs text-zinc-500">
        Only royalty-free or properly licensed music. When the library has no track for a mood, a royalty-free bed is synthesised automatically.
      </p>
      <ul className="max-h-64 space-y-2 overflow-y-auto text-sm scrollbar-thin">
        {tracks.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className={t.enabled ? "truncate text-zinc-200" : "truncate text-zinc-500 line-through"}>{t.title}</p>
              <p className="truncate text-xs text-zinc-500">
                {t.moods.join(", ")} · {Math.round(t.durationSec)}s · {t.license}
              </p>
            </div>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run(t.id, () => api(`/api/music/${t.id}`, { method: "PATCH", json: { enabled: !t.enabled } }))}>
              {t.enabled ? "Disable" : "Enable"}
            </Button>
          </li>
        ))}
        {tracks.length === 0 && <li className="text-zinc-500">No tracks yet.</li>}
      </ul>
      <form onSubmit={upload} className="mt-4 space-y-2 border-t border-zinc-800 pt-4">
        <Input name="file" type="file" accept="audio/*" required className="py-2" />
        <div className="grid grid-cols-2 gap-2">
          <Input name="title" placeholder="Title" required />
          <Input name="artist" placeholder="Artist (optional)" />
        </div>
        <Input name="moods" placeholder={`Moods, e.g. ${moods.slice(0, 3).join(", ")}`} required />
        <div className="grid grid-cols-2 gap-2">
          <Input name="license" placeholder="License (required)" required />
          <Input name="licenseUrl" placeholder="License URL" />
        </div>
        <Input name="attribution" placeholder="Attribution text (if required)" />
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" size="sm" variant="secondary" disabled={!!busy}>
          {busy === "upload" ? "Uploading..." : "Upload track"}
        </Button>
      </form>
    </Card>
  );
}
