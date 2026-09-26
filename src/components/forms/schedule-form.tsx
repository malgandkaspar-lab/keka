"use client";

import { useState, type FormEvent } from "react";
import { Alert, Badge, Button, Card, CardTitle, Input, Label, Select } from "@/components/ui/primitives";
import { api } from "@/lib/client-api";
import { formatDate, formatRelative } from "@/lib/format";
import { useAction } from "@/components/videos/video-actions";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface ScheduleView {
  id: string;
  name: string;
  enabled: boolean;
  daysOfWeek: number[];
  times: string[];
  timezone: string;
  videosPerRun: number;
  categories: string[];
  voicePresetId: string | null;
  templateKey: string | null;
  durationSec: number;
  musicMode: string;
  privacy: string;
  autoPublish: boolean;
  publishDelayMin: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  videoCount: number;
}

interface Options {
  categories: { key: string; name: string }[];
  voices: { id: string; name: string }[];
  templates: { key: string; name: string }[];
  youtubeConnected: boolean;
}

const PRESETS: { label: string; days: number[]; times: string[] }[] = [
  { label: "1 video every day", days: [0, 1, 2, 3, 4, 5, 6], times: ["15:00"] },
  { label: "2 videos every day", days: [0, 1, 2, 3, 4, 5, 6], times: ["10:00", "18:00"] },
  { label: "3 videos per week", days: [1, 3, 5], times: ["16:00"] },
];

export function ScheduleForm({ options, existing, onDone }: { options: Options; existing?: ScheduleView; onDone?: () => void }) {
  const { busy, error, run } = useAction();
  const [days, setDays] = useState<number[]>(existing?.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6]);
  const [times, setTimes] = useState(existing?.times.join(", ") ?? "15:00");
  const [categories, setCategories] = useState<string[]>(existing?.categories ?? [options.categories[0]?.key ?? "science"]);
  const [privacy, setPrivacy] = useState(existing?.privacy ?? "PRIVATE");
  const tz = existing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      name: form.get("name"),
      enabled: true,
      daysOfWeek: days,
      times: times.split(",").map((t) => t.trim()).filter(Boolean),
      timezone: form.get("timezone"),
      videosPerRun: Number(form.get("videosPerRun")),
      categories,
      voicePresetId: form.get("voice") || null,
      templateKey: form.get("template") || undefined,
      durationSec: Number(form.get("duration")),
      musicMode: form.get("music"),
      privacy,
      autoPublish: form.get("autoPublish") === "on",
      publishDelayMin: Number(form.get("publishDelayHours") ?? 0) * 60,
    };
    void run("save", async () => {
      await api(existing ? `/api/schedules/${existing.id}` : "/api/schedules", { method: existing ? "PATCH" : "POST", json: body });
      onDone?.();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <Button
            key={p.label}
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              setDays(p.days);
              setTimes(p.times.join(", "));
            }}
          >
            {p.label}
          </Button>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" defaultValue={existing?.name ?? "Daily science Shorts"} required />
        </div>
        <div>
          <Label htmlFor="timezone">Time zone</Label>
          <Input id="timezone" name="timezone" defaultValue={tz} required />
        </div>
      </div>
      <div>
        <Label>Days</Label>
        <div className="flex flex-wrap gap-2">
          {DAYS.map((d, i) => (
            <button
              type="button"
              key={d}
              onClick={() => setDays((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort()))}
              className={`h-9 w-12 rounded-lg border text-sm ${days.includes(i) ? "border-accent-500 bg-accent-500/20 text-white" : "border-zinc-700 text-zinc-400"}`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <Label htmlFor="times" hint="HH:MM, comma separated">Times</Label>
          <Input id="times" value={times} onChange={(e) => setTimes(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="videosPerRun">Videos per run</Label>
          <Input id="videosPerRun" name="videosPerRun" type="number" min={1} max={10} defaultValue={existing?.videosPerRun ?? 1} />
        </div>
        <div>
          <Label htmlFor="duration">Duration (sec)</Label>
          <Input id="duration" name="duration" type="number" min={10} max={180} defaultValue={existing?.durationSec ?? 30} />
        </div>
      </div>
      <div>
        <Label>Categories (rotated)</Label>
        <div className="flex flex-wrap gap-2">
          {options.categories.map((c) => (
            <button
              type="button"
              key={c.key}
              onClick={() => setCategories((cur) => (cur.includes(c.key) ? cur.filter((x) => x !== c.key) : [...cur, c.key]))}
              className={`rounded-full border px-3 py-1 text-xs ${categories.includes(c.key) ? "border-accent-500 bg-accent-500/20 text-white" : "border-zinc-700 text-zinc-400"}`}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <Label htmlFor="voice">Voice</Label>
          <Select id="voice" name="voice" defaultValue={existing?.voicePresetId ?? ""}>
            <option value="">Default voice</option>
            {options.voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="template">Style</Label>
          <Select id="template" name="template" defaultValue={existing?.templateKey ?? ""}>
            <option value="">Default style</option>
            {options.templates.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="music">Music</Label>
          <Select id="music" name="music" defaultValue={existing?.musicMode ?? "auto"}>
            <option value="auto">Automatic</option>
            <option value="none">No music</option>
          </Select>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <Label htmlFor="privacy">Privacy</Label>
          <Select id="privacy" value={privacy} onChange={(e) => setPrivacy(e.target.value)}>
            <option value="PRIVATE">Private</option>
            <option value="UNLISTED">Unlisted</option>
            <option value="PUBLIC">Public</option>
            <option value="SCHEDULED">Scheduled (publish later)</option>
          </Select>
        </div>
        {privacy === "SCHEDULED" && (
          <div>
            <Label htmlFor="publishDelayHours">Publish after (hours)</Label>
            <Input id="publishDelayHours" name="publishDelayHours" type="number" min={1} max={336} defaultValue={Math.max(1, Math.round((existing?.publishDelayMin ?? 180) / 60))} />
          </div>
        )}
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" name="autoPublish" defaultChecked={existing?.autoPublish ?? options.youtubeConnected} className="accent-indigo-500" />
          Upload automatically (AUTO MODE)
        </label>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" disabled={!!busy}>
        {busy ? "Saving..." : existing ? "Save schedule" : "Create schedule"}
      </Button>
    </form>
  );
}

export function ScheduleList({ schedules, options }: { schedules: ScheduleView[]; options: Options }) {
  const { busy, error, run } = useAction();
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      {schedules.map((s) => (
        <Card key={s.id}>
          <CardTitle action={<Badge tone={s.enabled ? "success" : "neutral"}>{s.enabled ? "active" : "paused"}</Badge>}>{s.name}</CardTitle>
          <p className="text-sm text-zinc-300">
            {s.videosPerRun} video{s.videosPerRun > 1 ? "s" : ""} at {s.times.join(", ")} on {s.daysOfWeek.map((d) => DAYS[d]).join(", ")} ({s.timezone}) · {s.durationSec}s · {s.privacy.toLowerCase()}
            {s.autoPublish ? " · auto-publish" : ""}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Categories: {s.categories.join(", ")} · Next run: {s.nextRunAt ? `${formatDate(s.nextRunAt)} (${formatRelative(s.nextRunAt)})` : "–"} · Last run: {formatDate(s.lastRunAt)} · {s.videoCount} videos so far
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => run(`run-${s.id}`, () => api(`/api/schedules/${s.id}/run`, { method: "POST" }))}>
              Run now
            </Button>
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => run(`toggle-${s.id}`, () => api(`/api/schedules/${s.id}`, { method: "PATCH", json: { enabled: !s.enabled } }))}>
              {s.enabled ? "Pause" : "Resume"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(editing === s.id ? null : s.id)}>
              {editing === s.id ? "Close" : "Edit"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-red-300"
              disabled={!!busy}
              onClick={() => confirm("Delete this schedule?") && run(`del-${s.id}`, () => api(`/api/schedules/${s.id}`, { method: "DELETE" }))}
            >
              Delete
            </Button>
          </div>
          {editing === s.id && (
            <div className="mt-5 border-t border-zinc-800 pt-5">
              <ScheduleForm options={options} existing={s} onDone={() => setEditing(null)} />
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
