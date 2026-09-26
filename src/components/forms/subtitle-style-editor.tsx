"use client";

import { useState, type FormEvent } from "react";
import { Alert, Button, Card, CardTitle, Input, Label, Select } from "@/components/ui/primitives";
import { api } from "@/lib/client-api";
import { useAction } from "@/components/videos/video-actions";
import type { SubtitleStyle } from "@/config/templates";

/** Create custom subtitle styles: font, size, position, words per line, animation, emphasis, timing. */
export function SubtitleStyleEditor({ fonts, custom, base }: { fonts: string[]; custom: SubtitleStyle[]; base: SubtitleStyle }) {
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const style = {
      ...base,
      name: String(f.get("name")),
      font: String(f.get("font")),
      fontSize: Number(f.get("fontSize")),
      position: f.get("position"),
      marginV: Number(f.get("marginV")),
      maxWordsPerLine: Number(f.get("maxWordsPerLine")),
      maxLines: Number(f.get("maxLines")),
      maxCueDurationSec: Number(f.get("maxCueDurationSec")),
      animation: f.get("animation"),
      emphasis: f.get("emphasis"),
      primaryColor: String(f.get("primaryColor")).toUpperCase(),
      highlightColor: String(f.get("highlightColor")).toUpperCase(),
      outlineWidth: Number(f.get("outlineWidth")),
      uppercase: f.get("uppercase") === "on",
      bold: f.get("bold") === "on",
      timingOffsetSec: Number(f.get("timingOffsetSec")),
    };
    void run("save", async () => {
      const res = await api<{ style: SubtitleStyle }>("/api/subtitle-styles", { method: "POST", json: style });
      setSaved(res.style.name);
    });
  }

  return (
    <Card>
      <CardTitle>Custom subtitle styles</CardTitle>
      {custom.length > 0 && (
        <ul className="mb-4 space-y-1 text-sm">
          {custom.map((s) => (
            <li key={s.key} className="flex items-center justify-between">
              <span className="text-zinc-200">
                {s.name} <span className="text-xs text-zinc-500">({s.font}, {s.fontSize}px, {s.position}, {s.maxWordsPerLine} words/line, {s.animation})</span>
              </span>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run(`del-${s.key}`, () => api(`/api/subtitle-styles?key=${encodeURIComponent(s.key)}`, { method: "DELETE" }))}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor="st-name">Name</Label>
          <Input id="st-name" name="name" placeholder="e.g. Bold Yellow" required />
        </div>
        <div>
          <Label htmlFor="st-font">Font</Label>
          <Select id="st-font" name="font" defaultValue={base.font}>
            {fonts.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="st-size">Size (px)</Label>
          <Input id="st-size" name="fontSize" type="number" min={24} max={200} defaultValue={base.fontSize} />
        </div>
        <div>
          <Label htmlFor="st-pos">Position</Label>
          <Select id="st-pos" name="position" defaultValue={base.position}>
            <option value="upper">Upper</option>
            <option value="center">Center</option>
            <option value="lower">Lower</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="st-margin" hint="px from bottom / offset">Vertical margin</Label>
          <Input id="st-margin" name="marginV" type="number" min={0} max={900} defaultValue={base.marginV} />
        </div>
        <div>
          <Label htmlFor="st-wpl">Max words per line</Label>
          <Input id="st-wpl" name="maxWordsPerLine" type="number" min={1} max={8} defaultValue={base.maxWordsPerLine} />
        </div>
        <div>
          <Label htmlFor="st-lines">Max lines</Label>
          <Input id="st-lines" name="maxLines" type="number" min={1} max={3} defaultValue={base.maxLines} />
        </div>
        <div>
          <Label htmlFor="st-anim">Animation</Label>
          <Select id="st-anim" name="animation" defaultValue={base.animation}>
            <option value="pop">Pop</option>
            <option value="fade">Fade</option>
            <option value="none">None</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="st-emph">Emphasis</Label>
          <Select id="st-emph" name="emphasis" defaultValue={base.emphasis}>
            <option value="highlight-word">Highlight spoken word</option>
            <option value="none">None</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="st-color">Text color</Label>
          <Input id="st-color" name="primaryColor" type="color" defaultValue={base.primaryColor} className="h-10 p-1" />
        </div>
        <div>
          <Label htmlFor="st-hl">Highlight color</Label>
          <Input id="st-hl" name="highlightColor" type="color" defaultValue={base.highlightColor} className="h-10 p-1" />
        </div>
        <div>
          <Label htmlFor="st-outline">Outline width</Label>
          <Input id="st-outline" name="outlineWidth" type="number" min={0} max={20} defaultValue={base.outlineWidth} />
        </div>
        <div>
          <Label htmlFor="st-cue" hint="seconds">Max cue duration</Label>
          <Input id="st-cue" name="maxCueDurationSec" type="number" step="0.1" min={0.5} max={6} defaultValue={base.maxCueDurationSec} />
        </div>
        <div>
          <Label htmlFor="st-offset" hint="seconds, ±1">Timing offset</Label>
          <Input id="st-offset" name="timingOffsetSec" type="number" step="0.05" min={-1} max={1} defaultValue={base.timingOffsetSec} />
        </div>
        <div className="flex items-end gap-4 pb-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="uppercase" defaultChecked={base.uppercase} className="accent-indigo-500" /> Uppercase
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="bold" defaultChecked={base.bold} className="accent-indigo-500" /> Bold
          </label>
        </div>
        {error && (
          <div className="sm:col-span-2">
            <Alert tone="danger">{error}</Alert>
          </div>
        )}
        {saved && !error && (
          <div className="sm:col-span-2">
            <Alert tone="success">Saved “{saved}”. Select it as the subtitle style in the settings above.</Alert>
          </div>
        )}
        <div className="sm:col-span-2">
          <Button type="submit" variant="secondary" disabled={!!busy}>
            Save style
          </Button>
        </div>
      </form>
    </Card>
  );
}
