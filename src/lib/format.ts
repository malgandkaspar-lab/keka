import type { VideoStatus } from "@/generated/prisma/enums";

/** Display helpers shared by server and client components. */
export const STATUS_LABELS: Record<VideoStatus, string> = {
  DRAFT: "Draft",
  TOPIC_GENERATING: "Generating topic",
  RESEARCHING: "Researching",
  SCRIPT_GENERATING: "Writing script",
  SCRIPT_REVIEW: "Reviewing script",
  VOICE_GENERATING: "Generating voice",
  MEDIA_SEARCHING: "Finding footage",
  EDITING: "Editing",
  SUBTITLES_GENERATING: "Subtitles",
  RENDERING: "Rendering",
  QUALITY_CHECK: "Quality check",
  READY: "Ready",
  UPLOADING: "Uploading",
  SCHEDULED: "Scheduled",
  PUBLISHED: "Published",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export type StatusTone = "neutral" | "progress" | "success" | "warning" | "danger" | "info";

export function statusTone(status: VideoStatus): StatusTone {
  switch (status) {
    case "READY":
    case "PUBLISHED":
      return "success";
    case "SCHEDULED":
      return "info";
    case "FAILED":
      return "danger";
    case "CANCELLED":
    case "DRAFT":
      return "neutral";
    default:
      return "progress";
  }
}

export function isProcessing(status: VideoStatus): boolean {
  return statusTone(status) === "progress";
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "–";
  const s = Math.round(seconds);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "–";
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatTime(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatRelative(value: Date | string | null | undefined): string {
  if (!value) return "–";
  const date = typeof value === "string" ? new Date(value) : value;
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), "second");
  if (abs < 3600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86400_000) return rtf.format(Math.round(diff / 3600_000), "hour");
  return rtf.format(Math.round(diff / 86400_000), "day");
}

export function formatUsd(value: number | null | undefined): string {
  if (value == null) return "–";
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value == null) return "–";
  return new Intl.NumberFormat("en-US", { notation: value >= 10_000 ? "compact" : "standard" }).format(value);
}

export function stepLabel(step: string): string {
  return step
    .toLowerCase()
    .split("_")
    .map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}
