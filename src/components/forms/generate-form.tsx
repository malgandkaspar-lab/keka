"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, Button, Card, Input, Label, Select } from "@/components/ui/primitives";
import { api, ApiClientError } from "@/lib/client-api";

export interface GenerateOptions {
  categories: { key: string; name: string }[];
  voices: { id: string; name: string; description: string | null; gender: string | null }[];
  templates: { key: string; name: string; description: string | null }[];
  moods: string[];
  durations: number[];
  youtubeConnected: boolean;
  defaults: {
    category: string;
    durationSec: number;
    voicePresetId: string | null;
    templateKey: string;
    musicMode: string;
    privacy: "PRIVATE" | "UNLISTED" | "PUBLIC" | "SCHEDULED";
    autoPublish: boolean;
  };
  missingCredentials: string[];
}

function localDateTimeValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function GenerateForm({ options }: { options: GenerateOptions }) {
  const router = useRouter();
  const [autoTopic, setAutoTopic] = useState(false);
  const [topic, setTopic] = useState("");
  const [suggestedId, setSuggestedId] = useState<string | null>(null);
  const [category, setCategory] = useState(options.defaults.category);
  const [duration, setDuration] = useState(String(options.defaults.durationSec));
  const [customDuration, setCustomDuration] = useState("");
  const [privacy, setPrivacy] = useState(options.defaults.privacy);
  const [autoPublish, setAutoPublish] = useState(options.defaults.autoPublish && options.youtubeConnected);
  const [publishAt, setPublishAt] = useState(() => localDateTimeValue(new Date(Date.now() + 24 * 3600_000)));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  async function suggest() {
    setSuggesting(true);
    setError(null);
    try {
      const res = await api<{ topic: { id: string; title: string } }>("/api/topics/suggest", { method: "POST", json: { category } });
      setTopic(res.topic.title);
      setSuggestedId(res.topic.id);
      setAutoTopic(false);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not suggest a topic");
    } finally {
      setSuggesting(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const durationSec = duration === "custom" ? Number(customDuration) : Number(duration);
    try {
      const res = await api<{ video: { id: string } }>("/api/videos", {
        method: "POST",
        json: {
          topic: autoTopic ? null : topic,
          topicId: autoTopic ? null : suggestedId,
          autoTopic,
          category,
          durationSec,
          voicePresetId: form.get("voice") || null,
          templateKey: form.get("template"),
          musicMode: form.get("music"),
          privacy,
          autoPublish,
          scheduledPublishAt: privacy === "SCHEDULED" ? new Date(publishAt).toISOString() : null,
        },
      });
      router.push(`/videos/${res.video.id}`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not start generation");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-6 lg:grid-cols-3">
      <Card className="space-y-5 lg:col-span-2">
        <div>
          <Label htmlFor="topic">Topic</Label>
          <Input
            id="topic"
            placeholder='e.g. "Why do astronauts grow taller in space?"'
            value={autoTopic ? "" : topic}
            onChange={(e) => {
              setTopic(e.target.value);
              setSuggestedId(null);
            }}
            disabled={autoTopic}
            maxLength={200}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="button" variant={autoTopic ? "primary" : "secondary"} size="sm" onClick={() => setAutoTopic((v) => !v)}>
              {autoTopic ? "✓ AI will choose the topic" : "Generate topic automatically"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={suggest} disabled={suggesting}>
              {suggesting ? "Thinking..." : "Suggest a topic now"}
            </Button>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            All content is generated in English. Topics are researched first; unsupported claims are avoided.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="category">Category</Label>
            <Select id="category" value={category} onChange={(e) => setCategory(e.target.value)}>
              {options.categories.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="duration">Duration</Label>
            <Select id="duration" value={duration} onChange={(e) => setDuration(e.target.value)}>
              {options.durations.map((d) => (
                <option key={d} value={d}>
                  {d} sec
                </option>
              ))}
              <option value="custom">Custom...</option>
            </Select>
            {duration === "custom" && (
              <Input className="mt-2" type="number" min={10} max={180} placeholder="Seconds (10-180)" value={customDuration} onChange={(e) => setCustomDuration(e.target.value)} required />
            )}
          </div>
          <div>
            <Label htmlFor="voice">Voice</Label>
            <Select id="voice" name="voice" defaultValue={options.defaults.voicePresetId ?? options.voices[0]?.id ?? ""}>
              {options.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} {v.gender ? `(${v.gender})` : ""} {v.description ? `– ${v.description}` : ""}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="template">Style</Label>
            <Select id="template" name="template" defaultValue={options.defaults.templateKey}>
              {options.templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="music">Music</Label>
            <Select id="music" name="music" defaultValue={options.defaults.musicMode}>
              <option value="auto">Automatic</option>
              {options.moods.map((m) => (
                <option key={m} value={m}>
                  {m[0]!.toUpperCase() + m.slice(1)}
                </option>
              ))}
              <option value="none">No music</option>
            </Select>
          </div>
        </div>
      </Card>

      <div className="space-y-6">
        <Card className="space-y-4">
          <div>
            <Label htmlFor="privacy">YouTube privacy</Label>
            <Select id="privacy" value={privacy} onChange={(e) => setPrivacy(e.target.value as typeof privacy)}>
              <option value="PRIVATE">Private</option>
              <option value="UNLISTED">Unlisted</option>
              <option value="PUBLIC">Public</option>
              <option value="SCHEDULED">Scheduled</option>
            </Select>
          </div>
          {privacy === "SCHEDULED" && (
            <div>
              <Label htmlFor="publishAt">Publish at</Label>
              <Input id="publishAt" type="datetime-local" value={publishAt} onChange={(e) => setPublishAt(e.target.value)} required />
            </div>
          )}
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" className="mt-1 accent-indigo-500" checked={autoPublish} onChange={(e) => setAutoPublish(e.target.checked)} disabled={!options.youtubeConnected} />
            <span>
              Upload to YouTube automatically when ready
              {!options.youtubeConnected && <span className="block text-xs text-zinc-500">Connect a channel on the YouTube page first.</span>}
            </span>
          </label>
        </Card>
        {options.missingCredentials.length > 0 && (
          <Alert tone="warning">
            Missing configuration: {options.missingCredentials.join(", ")}. Generation steps that need these will fail until they are set.
          </Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" size="lg" className="w-full" disabled={busy || (!autoTopic && topic.trim().length < 8)}>
          {busy ? "Starting..." : "GENERATE SHORT"}
        </Button>
      </div>
    </form>
  );
}
