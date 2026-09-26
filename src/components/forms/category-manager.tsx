"use client";

import { useState, type FormEvent } from "react";
import { Alert, Button, Card, CardTitle, Input, Label } from "@/components/ui/primitives";
import { api } from "@/lib/client-api";
import { useAction } from "@/components/videos/video-actions";

export function CategoryManager({ categories }: { categories: { key: string; name: string; description: string | null; enabled: boolean }[] }) {
  const { busy, error, run } = useAction();
  const [name, setName] = useState("");
  const [hints, setHints] = useState("");

  function add(event: FormEvent) {
    event.preventDefault();
    void run("add", async () => {
      await api("/api/categories", { method: "POST", json: { name, promptHints: hints || undefined } });
      setName("");
      setHints("");
    });
  }

  return (
    <Card>
      <CardTitle>Categories</CardTitle>
      <ul className="space-y-2">
        {categories.map((c) => (
          <li key={c.key} className="flex items-center justify-between gap-3 text-sm">
            <div>
              <p className={c.enabled ? "text-zinc-100" : "text-zinc-500 line-through"}>{c.name}</p>
              {c.description && <p className="text-xs text-zinc-500">{c.description}</p>}
            </div>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run(c.key, () => api("/api/categories", { method: "PATCH", json: { key: c.key, enabled: !c.enabled } }))}>
              {c.enabled ? "Disable" : "Enable"}
            </Button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="mt-5 space-y-3 border-t border-zinc-800 pt-4">
        <div>
          <Label htmlFor="cat-name">New category</Label>
          <Input id="cat-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Oceans" required minLength={2} />
        </div>
        <div>
          <Label htmlFor="cat-hints" hint="optional">Guidance for the AI</Label>
          <Input id="cat-hints" value={hints} onChange={(e) => setHints(e.target.value)} placeholder="What kind of topics fit this category?" />
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" variant="secondary" disabled={!!busy}>
          Add category
        </Button>
      </form>
    </Card>
  );
}
