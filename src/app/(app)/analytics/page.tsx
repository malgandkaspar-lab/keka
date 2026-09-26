import { AnalyticsRefresh } from "@/components/forms/analytics-refresh";
import { Card, CardTitle, EmptyState, PageHeader, Stat } from "@/components/ui/primitives";
import { requirePageUser } from "@/lib/auth";
import { formatDate, formatNumber } from "@/lib/format";
import { analyticsOverview } from "@/services/analytics/analytics-service";

export const metadata = { title: "Analytics" };

const DIMENSION_LABELS: Record<string, string> = {
  category: "Categories",
  hookStyle: "Hook styles",
  duration: "Durations",
  template: "Templates",
  publishHourUtc: "Publish hour (UTC)",
};

export default async function AnalyticsPage() {
  const user = await requirePageUser();
  const data = await analyticsOverview(user.id);
  const { totals } = data;
  const byDimension = new Map<string, typeof data.insights>();
  for (const insight of data.insights) byDimension.set(insight.dimension, [...(byDimension.get(insight.dimension) ?? []), insight]);

  return (
    <>
      <PageHeader
        title="Analytics"
        description="YouTube performance of uploaded Shorts. Collected every 6 hours; metrics YouTube does not provide stay empty."
        actions={<AnalyticsRefresh />}
      />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Uploaded" value={totals.videos} />
        <Stat label="Views" value={formatNumber(totals.views)} />
        <Stat label="Likes" value={formatNumber(totals.likes)} />
        <Stat label="Comments" value={formatNumber(totals.comments)} />
        <Stat label="Watch time" value={`${formatNumber(Math.round(totals.watchTimeMinutes))} min`} />
        <Stat label="Avg. viewed" value={totals.averageViewPercentage != null ? `${totals.averageViewPercentage}%` : "–"} hint={`+${totals.subscribersGained} subscribers`} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card className="p-0 xl:col-span-2">
          <div className="p-5 pb-0">
            <CardTitle>Videos</CardTitle>
          </div>
          {data.videos.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No uploaded videos yet" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-5 py-3">Video</th>
                    <th className="px-3 py-3 text-right">Views</th>
                    <th className="px-3 py-3 text-right">Likes</th>
                    <th className="px-3 py-3 text-right">Comments</th>
                    <th className="px-3 py-3 text-right">Avg. viewed</th>
                    <th className="px-3 py-3">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {data.videos.map((v) => (
                    <tr key={v.id}>
                      <td className="px-5 py-3">
                        <a href={`/videos/${v.id}`} className="text-zinc-100 hover:text-white">
                          {v.title}
                        </a>
                        <p className="text-xs text-zinc-500">{v.category.replaceAll("_", " ")}</p>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">{formatNumber(v.views)}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{formatNumber(v.likes)}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{formatNumber(v.comments)}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{v.averageViewPercentage != null ? `${v.averageViewPercentage.toFixed(0)}%` : "–"}</td>
                      <td className="px-3 py-3 text-zinc-500">{formatDate(v.capturedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card>
          <CardTitle>What performs well</CardTitle>
          {byDimension.size === 0 ? (
            <p className="text-sm text-zinc-500">Insights appear once at least 3 uploaded videos share a category, hook style, duration or template. They are fed back into topic and hook selection.</p>
          ) : (
            <div className="space-y-4">
              {[...byDimension.entries()].map(([dimension, rows]) => (
                <div key={dimension}>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{DIMENSION_LABELS[dimension] ?? dimension}</p>
                  <ul className="space-y-1 text-sm">
                    {rows.slice(0, 4).map((r) => (
                      <li key={r.id} className="flex justify-between gap-2">
                        <span className="text-zinc-200">{r.value.replaceAll("_", " ")}</span>
                        <span className="tabular-nums text-zinc-500">
                          {formatNumber(Math.round(r.avgViews))} avg views · n={r.sampleSize}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
