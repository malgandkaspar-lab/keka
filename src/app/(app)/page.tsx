import Link from "next/link";
import { Badge, Button, Card, CardTitle, EmptyState, PageHeader, Stat, StatusBadge } from "@/components/ui/primitives";
import { VideoThumb } from "@/components/videos/video-thumb";
import { AutoRefresh } from "@/components/videos/auto-refresh";
import { requirePageUser } from "@/lib/auth";
import { formatDate, formatRelative, formatUsd, stepLabel } from "@/lib/format";
import { dashboardData } from "@/services/dashboard/dashboard-service";

export const metadata = { title: "Dashboard" };

const JOB_TONES = { QUEUED: "neutral", RUNNING: "progress", COMPLETED: "success", FAILED: "danger", CANCELLED: "neutral", SUPERSEDED: "neutral" } as const;

export default async function DashboardPage() {
  const user = await requirePageUser();
  const data = await dashboardData(user.id);
  const { counts, usage } = data;

  return (
    <>
      <AutoRefresh active={counts.processing > 0} intervalMs={5000} />
      <PageHeader
        title="Dashboard"
        description="Everything your Shorts factory is producing."
        actions={
          <Link href="/generate">
            <Button>Generate Short</Button>
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Generated" value={counts.generated} />
        <Stat label="Published" value={counts.published} />
        <Stat label="Scheduled" value={counts.scheduled} />
        <Stat label="Processing" value={counts.processing} />
        <Stat label="Ready" value={counts.ready} />
        <Stat label="Failed" value={counts.failed} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card>
          <CardTitle>Next up</CardTitle>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-zinc-500">Next scheduled generation</dt>
              <dd className="text-zinc-100">
                {data.nextSchedule ? `${data.nextSchedule.name} · ${formatDate(data.nextSchedule.nextRunAt)} (${formatRelative(data.nextSchedule.nextRunAt)})` : "No active schedule"}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Next scheduled publish</dt>
              <dd className="text-zinc-100">
                {data.nextScheduledVideo ? `${data.nextScheduledVideo.title} · ${formatDate(data.nextScheduledVideo.scheduledPublishAt)}` : "Nothing scheduled"}
              </dd>
            </div>
          </dl>
        </Card>
        <Card>
          <CardTitle>Usage today</CardTitle>
          <p className="text-3xl font-semibold text-white tabular-nums">
            {usage.videosToday}
            <span className="text-base font-normal text-zinc-500"> / {usage.dailyLimit} videos</span>
          </p>
          <p className="mt-2 text-sm text-zinc-400">Estimated cost today: {formatUsd(usage.costToday)}</p>
        </Card>
        <Card>
          <CardTitle>This month</CardTitle>
          <p className="text-3xl font-semibold text-white tabular-nums">
            {usage.videosThisMonth}
            <span className="text-base font-normal text-zinc-500"> / {usage.monthlyLimit} videos</span>
          </p>
          <p className="mt-2 text-sm text-zinc-400">
            Estimated {formatUsd(usage.costThisMonth)} of {formatUsd(usage.monthlyBudgetUsd)} budget
          </p>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-5">
        <Card className="xl:col-span-3">
          <CardTitle action={<Link href="/videos" className="text-sm text-accent-300 hover:underline">View all</Link>}>Recent videos</CardTitle>
          {data.recentVideos.length === 0 ? (
            <EmptyState title="No videos yet">
              <Link href="/generate" className="text-accent-300 hover:underline">Generate your first Short</Link>
            </EmptyState>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {data.recentVideos.map((video) => (
                <Link key={video.id} href={`/videos/${video.id}`} className="group">
                  <VideoThumb storageKey={video.thumbnailAsset?.storageKey} alt={video.title ?? "Video"} className="group-hover:ring-2 group-hover:ring-accent-500" />
                  <p className="mt-2 line-clamp-2 text-sm text-zinc-200">{video.title ?? video.topic?.title ?? video.requestedTopic ?? "Automatic topic"}</p>
                  <div className="mt-1">
                    <StatusBadge status={video.status} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Card>
        <Card className="xl:col-span-2">
          <CardTitle>Recent jobs</CardTitle>
          {data.recentJobs.length === 0 ? (
            <p className="text-sm text-zinc-500">No jobs yet.</p>
          ) : (
            <ul className="divide-y divide-zinc-800">
              {data.recentJobs.map((job) => (
                <li key={job.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <Link href={`/videos/${job.videoId}`} className="block truncate text-sm text-zinc-200 hover:text-white">
                      {stepLabel(job.step)}
                    </Link>
                    <p className="truncate text-xs text-zinc-500">
                      {job.video.title ?? job.video.topic?.title ?? job.video.requestedTopic ?? "Automatic topic"} · {formatRelative(job.updatedAt)}
                    </p>
                  </div>
                  <Badge tone={JOB_TONES[job.status]} pulse={job.status === "RUNNING"}>
                    {job.status.toLowerCase()}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
