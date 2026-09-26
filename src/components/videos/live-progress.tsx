"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { JobStatus, LogLevel, PipelineStep, VideoStatus } from "@/generated/prisma/enums";
import { Badge, Card, CardTitle, ProgressBar, StatusBadge, cn } from "@/components/ui/primitives";
import { formatTime, isProcessing } from "@/lib/format";

interface StepView {
  step: PipelineStep;
  label: string;
  status: JobStatus | "PENDING";
  progress: number;
  error: string | null;
}

interface LogView {
  id: string;
  level: LogLevel;
  message: string;
  createdAt: string;
}

interface ProgressEvent {
  video: { status: VideoStatus; error: string | null; failedStep: PipelineStep | null };
  jobs: { step: PipelineStep; status: JobStatus; progress: number; error: string | null }[];
  logs: LogView[];
}

const STEP_ICON: Record<string, string> = { COMPLETED: "✓", RUNNING: "●", QUEUED: "…", FAILED: "✕", CANCELLED: "–", SUPERSEDED: "↺", PENDING: "○" };

/** Live pipeline progress + structured log console (Server-Sent Events). */
export function LiveProgress({
  videoId,
  initialStatus,
  initialSteps,
  initialLogs,
  showPublishSteps,
}: {
  videoId: string;
  initialStatus: VideoStatus;
  initialSteps: StepView[];
  initialLogs: LogView[];
  showPublishSteps: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState(initialSteps);
  const [logs, setLogs] = useState(initialLogs);
  const statusRef = useRef(initialStatus);
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const since = initialLogs.at(-1)?.createdAt ? new Date(initialLogs.at(-1)!.createdAt).getTime() : 0;
    const source = new EventSource(`/api/videos/${videoId}/events?since=${since}`);
    source.addEventListener("progress", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as ProgressEvent;
      setStatus(data.video.status);
      setError(data.video.error);
      setSteps((current) =>
        current.map((s) => {
          const jobs = data.jobs.filter((j) => j.step === s.step);
          const job = jobs.at(-1);
          return job ? { ...s, status: job.status, progress: job.progress, error: job.error } : s;
        }),
      );
      if (data.logs.length) setLogs((current) => [...current, ...data.logs.filter((l) => !current.some((c) => c.id === l.id))].slice(-400));
      if (statusRef.current !== data.video.status) {
        const wasProcessing = isProcessing(statusRef.current);
        statusRef.current = data.video.status;
        if (wasProcessing && !isProcessing(data.video.status)) router.refresh();
      }
    });
    return () => source.close();
  }, [videoId, initialLogs, router]);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "nearest" });
  }, [logs.length]);

  const visibleSteps = useMemo(() => steps.filter((s) => showPublishSteps || !s.step.startsWith("YOUTUBE")), [steps, showPublishSteps]);
  const current = visibleSteps.find((s) => s.status === "RUNNING") ?? visibleSteps.find((s) => s.status === "QUEUED");
  const done = visibleSteps.filter((s) => s.status === "COMPLETED").length;

  return (
    <Card>
      <CardTitle action={<StatusBadge status={status} />}>Generation progress</CardTitle>
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="text-zinc-300">{current ? current.label : isProcessing(status) ? "Waiting for worker..." : status === "FAILED" ? "Stopped" : "Complete"}</span>
          <span className="tabular-nums text-zinc-500">
            {done}/{visibleSteps.length} steps
          </span>
        </div>
        <ProgressBar value={(done / visibleSteps.length) * 100 + (current ? current.progress / visibleSteps.length : 0)} />
      </div>
      {error && status === "FAILED" && <p className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
      <ol className="grid gap-1 text-sm sm:grid-cols-2">
        {visibleSteps.map((s) => (
          <li key={s.step} className={cn("flex items-center gap-2 rounded-md px-2 py-1", s.status === "RUNNING" && "bg-accent-500/10")}>
            <span
              className={cn(
                "w-4 text-center",
                s.status === "COMPLETED" && "text-emerald-400",
                s.status === "RUNNING" && "animate-pulse text-accent-300",
                s.status === "FAILED" && "text-red-400",
                (s.status === "PENDING" || s.status === "SUPERSEDED") && "text-zinc-600",
              )}
            >
              {STEP_ICON[s.status]}
            </span>
            <span className={cn(s.status === "PENDING" ? "text-zinc-500" : "text-zinc-200")}>{s.label.replace("...", "")}</span>
            {s.status === "RUNNING" && s.progress > 0 && <span className="ml-auto text-xs tabular-nums text-zinc-500">{s.progress}%</span>}
          </li>
        ))}
      </ol>
      <div className="mt-5">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Logs</p>
        <div className="max-h-72 overflow-y-auto rounded-lg border border-zinc-800 bg-black/40 p-3 font-mono text-xs scrollbar-thin">
          {logs.length === 0 && <p className="text-zinc-600">No log entries yet.</p>}
          {logs.map((log) => (
            <div key={log.id} className="flex gap-3 py-0.5">
              <span className="shrink-0 text-zinc-600">{formatTime(log.createdAt)}</span>
              <span className={cn(log.level === "ERROR" && "text-red-400", log.level === "WARN" && "text-amber-300", log.level === "INFO" && "text-zinc-300")}>{log.message}</span>
            </div>
          ))}
          <div ref={logEnd} />
        </div>
      </div>
      {status === "SCHEDULED" && (
        <div className="mt-3">
          <Badge tone="info">Scheduled on YouTube</Badge>
        </div>
      )}
    </Card>
  );
}
