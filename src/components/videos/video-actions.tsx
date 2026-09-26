"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { VideoStatus } from "@/generated/prisma/enums";
import { Alert, Button, Card, CardTitle, Select } from "@/components/ui/primitives";
import { api, ApiClientError } from "@/lib/client-api";
import { isProcessing } from "@/lib/format";

const REGENERATE_OPTIONS = [
  { value: "all", label: "Entire video (new topic if automatic)" },
  { value: "research", label: "Research + everything after" },
  { value: "script", label: "Script only (and what depends on it)" },
  { value: "voice", label: "Voice only" },
  { value: "visuals", label: "Visual plan + footage" },
  { value: "footage", label: "Footage only" },
  { value: "subtitles", label: "Subtitles only" },
  { value: "music", label: "Music only" },
  { value: "render", label: "Re-render (keep all assets)" },
  { value: "metadata", label: "Title / description / hashtags" },
  { value: "thumbnail", label: "Thumbnail" },
];

export function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }
  return { busy, error, run };
}

export function VideoActions({
  videoId,
  status,
  uploaded,
  youtubeConnected,
}: {
  videoId: string;
  status: VideoStatus;
  uploaded: boolean;
  youtubeConnected: boolean;
}) {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const [target, setTarget] = useState("render");
  const processing = isProcessing(status);
  const action = (body: Record<string, unknown>) => api(`/api/videos/${videoId}/actions`, { method: "POST", json: body });

  return (
    <Card>
      <CardTitle>Actions</CardTitle>
      <div className="flex flex-wrap gap-2">
        {processing && (
          <Button variant="danger" onClick={() => run("cancel", () => action({ action: "cancel" }))} disabled={!!busy}>
            {busy === "cancel" ? "Cancelling..." : "Cancel job"}
          </Button>
        )}
        {(status === "FAILED" || status === "CANCELLED") && (
          <Button onClick={() => run("resume", () => action({ action: "resume" }))} disabled={!!busy}>
            {busy === "resume" ? "Resuming..." : "Retry from failed step"}
          </Button>
        )}
        {status === "READY" && !uploaded && (
          <Button onClick={() => run("publish", () => action({ action: "publish" }))} disabled={!!busy || !youtubeConnected} title={youtubeConnected ? "" : "Connect a YouTube channel first"}>
            {busy === "publish" ? "Queuing upload..." : "Publish to YouTube"}
          </Button>
        )}
        {uploaded && status !== "UPLOADING" && (
          <Button variant="secondary" onClick={() => run("sync", () => action({ action: "publish" }))} disabled={!!busy}>
            Sync YouTube status
          </Button>
        )}
      </div>
      {!uploaded && !processing && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Select value={target} onChange={(e) => setTarget(e.target.value)} className="max-w-xs">
            {REGENERATE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Button variant="secondary" onClick={() => run("regenerate", () => action({ action: "regenerate", target }))} disabled={!!busy}>
            {busy === "regenerate" ? "Starting..." : "Regenerate"}
          </Button>
        </div>
      )}
      {!processing && (
        <div className="mt-4 border-t border-zinc-800 pt-4">
          <Button
            variant="ghost"
            size="sm"
            className="text-red-300"
            disabled={!!busy}
            onClick={() => {
              if (!confirm("Delete this video and its generated files? This cannot be undone.")) return;
              void run("delete", async () => {
                await api(`/api/videos/${videoId}`, { method: "DELETE" });
                router.push("/videos");
              });
            }}
          >
            Delete video
          </Button>
        </div>
      )}
      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </Card>
  );
}
