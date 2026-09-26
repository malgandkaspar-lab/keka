"use client";

import { useState, type FormEvent } from "react";
import { Alert, Button, Card, CardTitle, Input, Label, Select, Textarea } from "@/components/ui/primitives";
import { api } from "@/lib/client-api";
import { formatDuration } from "@/lib/format";
import { useAction } from "./video-actions";

/** Manual override editors: metadata, script, voice/music/publishing, scenes. */

function toLocalInput(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function MetadataEditor({
  videoId,
  initial,
  disabled,
}: {
  videoId: string;
  initial: { title: string; description: string; hashtags: string[]; tags: string[]; thumbnailText: string };
  disabled: boolean;
}) {
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const list = (v: FormDataEntryValue | null) => String(v ?? "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    void run("save", async () => {
      await api(`/api/videos/${videoId}`, {
        method: "PATCH",
        json: {
          metadata: {
            title: form.get("title"),
            description: form.get("description"),
            hashtags: list(form.get("hashtags")),
            tags: list(form.get("tags")),
            thumbnailText: form.get("thumbnailText") || null,
          },
        },
      });
      setSaved(true);
    });
  }

  return (
    <Card>
      <CardTitle>Title, description & hashtags</CardTitle>
      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <Label htmlFor="title" hint="max 100 characters">Title</Label>
          <Input id="title" name="title" defaultValue={initial.title} maxLength={100} required disabled={disabled} />
        </div>
        <div>
          <Label htmlFor="description">Description</Label>
          <Textarea id="description" name="description" rows={6} defaultValue={initial.description} required disabled={disabled} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="hashtags" hint="comma separated">Hashtags</Label>
            <Input id="hashtags" name="hashtags" defaultValue={initial.hashtags.join(", ")} disabled={disabled} />
          </div>
          <div>
            <Label htmlFor="thumbnailText">Thumbnail text</Label>
            <Input id="thumbnailText" name="thumbnailText" defaultValue={initial.thumbnailText} maxLength={60} disabled={disabled} />
          </div>
        </div>
        <div>
          <Label htmlFor="tags" hint="comma separated">Tags</Label>
          <Input id="tags" name="tags" defaultValue={initial.tags.join(", ")} disabled={disabled} />
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        {saved && !error && <Alert tone="success">Saved. English validation and the thumbnail will be re-run.</Alert>}
        <Button type="submit" variant="secondary" disabled={disabled || !!busy}>
          {busy ? "Saving..." : "Save metadata"}
        </Button>
      </form>
    </Card>
  );
}

export function ScriptEditor({ videoId, text, estimatedSec, targetSec, disabled }: { videoId: string; text: string; estimatedSec: number | null; targetSec: number; disabled: boolean }) {
  const { busy, error, run } = useAction();
  const [value, setValue] = useState(text);
  const words = value.split(/\s+/).filter(Boolean).length;
  return (
    <Card>
      <CardTitle>
        Script{" "}
        <span className="ml-2 font-normal normal-case text-zinc-500">
          ~{formatDuration(estimatedSec)} of {targetSec}s target · {words} words
        </span>
      </CardTitle>
      <Textarea rows={9} value={value} onChange={(e) => setValue(e.target.value)} disabled={disabled} />
      <p className="mt-2 text-xs text-zinc-500">Saving a manual edit re-validates the script (English is mandatory) and regenerates the voice, subtitles and render.</p>
      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      <Button
        className="mt-3"
        variant="secondary"
        disabled={disabled || !!busy || value.trim() === text.trim()}
        onClick={() => run("script", () => api(`/api/videos/${videoId}/script`, { method: "PUT", json: { text: value } }))}
      >
        {busy ? "Saving..." : "Save script & regenerate"}
      </Button>
    </Card>
  );
}

export function ComponentEditor({
  videoId,
  voices,
  tracks,
  moods,
  current,
  disabled,
}: {
  videoId: string;
  voices: { id: string; name: string }[];
  tracks: { id: string; title: string; moods: string[] }[];
  moods: string[];
  current: {
    voicePresetId: string | null;
    voice: { speed: number; stability: number; similarityBoost: number; style: number; useSpeakerBoost: boolean };
    musicMode: string; musicTrackId: string | null; privacy: string; scheduledPublishAt: string | null; autoPublish: boolean };
  disabled: boolean;
}) {
  const { busy, error, run } = useAction();
  const [privacy, setPrivacy] = useState(current.privacy);

  function submit(event: FormEvent<HTMLFormElement>, kind: "voice" | "music" | "publishing") {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {};
    if (kind === "voice") {
      body.voicePresetId = form.get("voice");
      body.voiceSettings = {
        speed: Number(form.get("speed")),
        stability: Number(form.get("stability")),
        similarityBoost: Number(form.get("similarityBoost")),
        style: Number(form.get("style")),
        useSpeakerBoost: form.get("useSpeakerBoost") === "on",
      };
    } else if (kind === "music") {
      const choice = String(form.get("music"));
      if (choice.startsWith("track:")) body.musicTrackId = choice.slice(6);
      else {
        body.musicTrackId = null;
        body.musicMode = choice;
      }
    } else {
      body.privacy = form.get("privacy");
      body.autoPublish = form.get("autoPublish") === "on";
      const when = form.get("publishAt");
      body.scheduledPublishAt = privacy === "SCHEDULED" && when ? new Date(String(when)).toISOString() : null;
      body.applyNow = false;
    }
    void run(kind, () => api(`/api/videos/${videoId}`, { method: "PATCH", json: body }));
  }

  return (
    <Card className="space-y-6">
      <CardTitle>Voice, music & publishing</CardTitle>
      <form onSubmit={(e) => submit(e, "voice")} className="space-y-3">
        <div>
          <Label htmlFor="voice">English voice</Label>
          <Select id="voice" name="voice" defaultValue={current.voicePresetId ?? voices[0]?.id} disabled={disabled}>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <Label htmlFor="speed" hint="0.7-1.2">Speed</Label>
            <Input id="speed" name="speed" type="number" step="0.05" min={0.7} max={1.2} defaultValue={current.voice.speed} disabled={disabled} />
          </div>
          <div>
            <Label htmlFor="stability" hint="0-1">Stability</Label>
            <Input id="stability" name="stability" type="number" step="0.05" min={0} max={1} defaultValue={current.voice.stability} disabled={disabled} />
          </div>
          <div>
            <Label htmlFor="similarityBoost" hint="0-1">Similarity</Label>
            <Input id="similarityBoost" name="similarityBoost" type="number" step="0.05" min={0} max={1} defaultValue={current.voice.similarityBoost} disabled={disabled} />
          </div>
          <div>
            <Label htmlFor="style" hint="0-1">Style</Label>
            <Input id="style" name="style" type="number" step="0.05" min={0} max={1} defaultValue={current.voice.style} disabled={disabled} />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="useSpeakerBoost" defaultChecked={current.voice.useSpeakerBoost} className="accent-indigo-500" disabled={disabled} /> Speaker boost
          </label>
          <Button type="submit" variant="secondary" disabled={disabled || !!busy}>
            Apply voice settings
          </Button>
        </div>
      </form>
      <form onSubmit={(e) => submit(e, "music")} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <Label htmlFor="music">Music</Label>
          <Select id="music" name="music" defaultValue={current.musicTrackId ? `track:${current.musicTrackId}` : current.musicMode} disabled={disabled}>
            <option value="auto">Automatic (match the topic)</option>
            {moods.map((m) => (
              <option key={m} value={m}>
                Mood: {m}
              </option>
            ))}
            {tracks.map((t) => (
              <option key={t.id} value={`track:${t.id}`}>
                Track: {t.title}
              </option>
            ))}
            <option value="none">No music</option>
          </Select>
        </div>
        <Button type="submit" variant="secondary" disabled={disabled || !!busy}>
          Change music
        </Button>
      </form>
      <form onSubmit={(e) => submit(e, "publishing")} className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="privacy">Privacy</Label>
          <Select id="privacy" name="privacy" value={privacy} onChange={(e) => setPrivacy(e.target.value)}>
            <option value="PRIVATE">Private</option>
            <option value="UNLISTED">Unlisted</option>
            <option value="PUBLIC">Public</option>
            <option value="SCHEDULED">Scheduled</option>
          </Select>
        </div>
        {privacy === "SCHEDULED" && (
          <div>
            <Label htmlFor="publishAt">Publish at</Label>
            <Input id="publishAt" name="publishAt" type="datetime-local" defaultValue={toLocalInput(current.scheduledPublishAt)} required />
          </div>
        )}
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="autoPublish" defaultChecked={current.autoPublish} className="accent-indigo-500" />
          Upload automatically when the video is ready
        </label>
        <div className="sm:col-span-2">
          <Button type="submit" variant="secondary" disabled={!!busy}>
            Save publishing settings
          </Button>
        </div>
      </form>
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}

interface SceneView {
  id: string;
  index: number;
  startSec: number;
  endSec: number;
  narration: string;
  visualDescription: string;
  keywords: string[];
  locked: boolean;
  mediaUrl: string | null;
  mediaKind: string | null;
  author: string | null;
  sourceUrl: string | null;
  candidates: { id: string; previewImage?: string; author: string; kind: string; width: number; height: number; durationSec: number }[];
}

export function SceneEditor({ videoId, scenes, disabled }: { videoId: string; scenes: SceneView[]; disabled: boolean }) {
  const { busy, error, run } = useAction();
  const [openScene, setOpenScene] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Record<string, SceneView["candidates"]>>({});
  const [queries, setQueries] = useState<Record<string, string>>({});
  const [changed, setChanged] = useState(false);

  return (
    <Card>
      <CardTitle
        action={
          changed && (
            <Button size="sm" onClick={() => run("rerender", () => api(`/api/videos/${videoId}/actions`, { method: "POST", json: { action: "regenerate", target: "render" } }))} disabled={!!busy || disabled}>
              Re-render with changes
            </Button>
          )
        }
      >
        Scenes
      </CardTitle>
      {scenes.length === 0 && <p className="text-sm text-zinc-500">Scenes appear after the visual plan is created.</p>}
      <div className="space-y-3">
        {scenes.map((scene) => {
          const list = candidates[scene.id] ?? scene.candidates;
          return (
            <div key={scene.id} className="rounded-lg border border-zinc-800 p-3">
              <div className="flex gap-3">
                <div className="aspect-[9/16] w-16 shrink-0 overflow-hidden rounded bg-zinc-800">
                  {scene.mediaUrl && scene.mediaKind === "VIDEO_CLIP" && <video src={scene.mediaUrl} muted preload="metadata" className="h-full w-full object-cover" />}
                  {scene.mediaUrl && scene.mediaKind === "IMAGE" && (
                    // eslint-disable-next-line @next/next/no-img-element -- authenticated media route
                    <img src={scene.mediaUrl} alt="" className="h-full w-full object-cover" />
                  )}
                </div>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="text-xs text-zinc-500">
                    Scene {scene.index + 1} · {scene.startSec.toFixed(1)}–{scene.endSec.toFixed(1)}s ({formatDuration(scene.endSec - scene.startSec)}){scene.locked && " · manually chosen"}
                  </p>
                  <p className="mt-1 text-zinc-100">“{scene.narration}”</p>
                  <p className="mt-1 text-zinc-400">Visual: {scene.visualDescription}</p>
                  <p className="mt-1 text-xs text-zinc-500">Keywords: {scene.keywords.join(", ")}</p>
                  {scene.author && (
                    <p className="mt-1 text-xs text-zinc-600">
                      Footage by {scene.author}
                      {scene.sourceUrl && (
                        <>
                          {" · "}
                          <a href={scene.sourceUrl} target="_blank" rel="noreferrer" className="hover:underline">
                            source
                          </a>
                        </>
                      )}
                    </p>
                  )}
                </div>
                <Button size="sm" variant="ghost" onClick={() => setOpenScene(openScene === scene.id ? null : scene.id)} disabled={disabled}>
                  {openScene === scene.id ? "Close" : "Replace"}
                </Button>
              </div>
              {openScene === scene.id && (
                <div className="mt-3 border-t border-zinc-800 pt-3">
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const query = queries[scene.id] ?? scene.keywords[0] ?? "";
                      void run(`search-${scene.id}`, async () => {
                        const res = await api<{ candidates: SceneView["candidates"] }>(`/api/videos/${videoId}/scenes/${scene.id}`, { method: "POST", json: { action: "search", query } });
                        setCandidates((c) => ({ ...c, [scene.id]: res.candidates }));
                      });
                    }}
                  >
                    <Input placeholder="Search stock footage (English)" value={queries[scene.id] ?? scene.keywords[0] ?? ""} onChange={(e) => setQueries((q) => ({ ...q, [scene.id]: e.target.value }))} />
                    <Button type="submit" variant="secondary" disabled={!!busy}>
                      Search
                    </Button>
                  </form>
                  <div className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-6">
                    {list.map((c) => (
                      <button
                        key={c.id}
                        className="group relative aspect-[9/16] overflow-hidden rounded bg-zinc-800 ring-accent-500 hover:ring-2"
                        disabled={!!busy}
                        onClick={() =>
                          run(`select-${c.id}`, async () => {
                            await api(`/api/videos/${videoId}/scenes/${scene.id}`, { method: "POST", json: { action: "select", candidateId: c.id } });
                            setChanged(true);
                            setOpenScene(null);
                          })
                        }
                        title={`${c.author} · ${c.width}x${c.height}${c.kind === "video" ? ` · ${c.durationSec}s` : " · image"}`}
                      >
                        {c.previewImage && (
                          // eslint-disable-next-line @next/next/no-img-element -- remote Pexels preview
                          <img src={c.previewImage} alt="" className="h-full w-full object-cover" />
                        )}
                        <span className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 text-[10px] text-zinc-200">{c.kind === "video" ? `${c.durationSec}s` : "image"}</span>
                      </button>
                    ))}
                  </div>
                  {list.length === 0 && <p className="text-xs text-zinc-500">No candidates yet - search for footage.</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </Card>
  );
}
