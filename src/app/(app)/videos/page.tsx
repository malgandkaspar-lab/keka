import Link from "next/link";
import type { Prisma } from "@/generated/prisma/client";
import type { VideoStatus } from "@/generated/prisma/enums";
import { Button, Card, EmptyState, PageHeader, StatusBadge } from "@/components/ui/primitives";
import { VideoThumb } from "@/components/videos/video-thumb";
import { AutoRefresh } from "@/components/videos/auto-refresh";
import { requirePageUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDate, formatDuration, isProcessing } from "@/lib/format";

export const metadata = { title: "Videos" };

const FILTERS: { label: string; statuses?: VideoStatus[] }[] = [
  { label: "All" },
  { label: "Processing", statuses: ["TOPIC_GENERATING", "RESEARCHING", "SCRIPT_GENERATING", "SCRIPT_REVIEW", "VOICE_GENERATING", "MEDIA_SEARCHING", "EDITING", "SUBTITLES_GENERATING", "RENDERING", "QUALITY_CHECK", "UPLOADING"] },
  { label: "Ready", statuses: ["READY"] },
  { label: "Scheduled", statuses: ["SCHEDULED"] },
  { label: "Published", statuses: ["PUBLISHED"] },
  { label: "Failed", statuses: ["FAILED", "CANCELLED"] },
];

export default async function VideosPage(props: PageProps<"/videos">) {
  const user = await requirePageUser();
  const searchParams = await props.searchParams;
  const filterLabel = typeof searchParams.filter === "string" ? searchParams.filter : "All";
  const filter = FILTERS.find((f) => f.label === filterLabel) ?? FILTERS[0]!;
  const where: Prisma.VideoWhereInput = { userId: user.id, ...(filter.statuses ? { status: { in: filter.statuses } } : {}) };
  const videos = await db.video.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { topic: { select: { title: true } }, thumbnailAsset: { select: { storageKey: true } } },
  });

  return (
    <>
      <AutoRefresh active={videos.some((v) => isProcessing(v.status))} />
      <PageHeader
        title="Videos"
        description="Your generated Shorts."
        actions={
          <Link href="/generate">
            <Button>Generate Short</Button>
          </Link>
        }
      />
      <div className="mb-5 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.label}
            href={f.label === "All" ? "/videos" : `/videos?filter=${f.label}`}
            className={`rounded-full border px-3 py-1 text-sm ${f.label === filter.label ? "border-accent-500 bg-accent-500/15 text-white" : "border-zinc-800 text-zinc-400 hover:text-white"}`}
          >
            {f.label}
          </Link>
        ))}
      </div>
      {videos.length === 0 ? (
        <EmptyState title="No videos here yet">
          <Link href="/generate" className="text-accent-300 hover:underline">Generate a Short</Link>
        </EmptyState>
      ) : (
        <Card className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-4 py-3">Video</th>
                  <th className="px-4 py-3">Duration</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">YouTube</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {videos.map((video) => (
                  <tr key={video.id} className="hover:bg-zinc-900/60">
                    <td className="px-4 py-3">
                      <Link href={`/videos/${video.id}`} className="flex items-center gap-3">
                        <VideoThumb storageKey={video.thumbnailAsset?.storageKey} alt={video.title ?? "Video"} className="w-12 shrink-0" />
                        <div className="min-w-0">
                          <p className="line-clamp-2 font-medium text-zinc-100">{video.title ?? video.topic?.title ?? video.requestedTopic ?? "Automatic topic"}</p>
                          <p className="text-xs text-zinc-500">{video.category.replaceAll("_", " ")}</p>
                        </div>
                      </Link>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-zinc-300">{formatDuration(video.actualDurationSec ?? video.targetDurationSec)}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={video.status} />
                    </td>
                    <td className="px-4 py-3 text-zinc-400">{formatDate(video.createdAt)}</td>
                    <td className="px-4 py-3 text-zinc-400">
                      {video.youtubeUrl ? (
                        <a href={video.youtubeUrl} target="_blank" rel="noreferrer" className="text-accent-300 hover:underline">
                          {video.youtubeStatus ?? "uploaded"}
                        </a>
                      ) : (
                        <span className="text-zinc-600">{video.privacy === "SCHEDULED" ? "to be scheduled" : "not uploaded"}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/videos/${video.id}`} className="text-accent-300 hover:underline">
                        {video.status === "READY" ? "Preview & publish" : video.status === "FAILED" ? "Inspect" : "Open"}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
