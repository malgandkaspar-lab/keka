import { Badge, Card, CardTitle, EmptyState, PageHeader } from "@/components/ui/primitives";
import { CategoryManager } from "@/components/forms/category-manager";
import { requirePageUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/format";

export const metadata = { title: "Topics" };

export default async function TopicsPage() {
  const user = await requirePageUser();
  const [topics, categories] = await Promise.all([
    db.topic.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { _count: { select: { videos: true, references: true } } },
    }),
    db.topicCategory.findMany({ orderBy: { sortOrder: "asc" } }),
  ]);
  const categoryName = new Map(categories.map((c) => [c.key, c.name]));

  return (
    <>
      <PageHeader title="Topics" description="Topic history (used for deduplication) and the categories the AI can choose from." />
      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="p-0 xl:col-span-2">
          <div className="p-5 pb-0">
            <CardTitle>History</CardTitle>
          </div>
          {topics.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No topics yet" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-5 py-3">Topic</th>
                    <th className="px-3 py-3">Category</th>
                    <th className="px-3 py-3">Source</th>
                    <th className="px-3 py-3">Score</th>
                    <th className="px-3 py-3">Research</th>
                    <th className="px-3 py-3">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {topics.map((topic) => (
                    <tr key={topic.id}>
                      <td className="px-5 py-3">
                        <p className="text-zinc-100">{topic.title}</p>
                        {topic.angle && <p className="text-xs text-zinc-500">{topic.angle}</p>}
                      </td>
                      <td className="px-3 py-3 text-zinc-400">{categoryName.get(topic.category) ?? topic.category}</td>
                      <td className="px-3 py-3">
                        <Badge tone={topic.source === "AI" ? "progress" : "neutral"}>{topic.source.toLowerCase()}</Badge>
                        {topic.status === "REJECTED" && <Badge tone="danger">rejected</Badge>}
                      </td>
                      <td className="px-3 py-3 tabular-nums text-zinc-300">{topic.overallScore?.toFixed(1) ?? "–"}</td>
                      <td className="px-3 py-3">
                        <Badge tone={topic.researchStatus === "COMPLETED" ? "success" : topic.researchStatus === "INSUFFICIENT" ? "warning" : "neutral"}>
                          {topic.researchStatus.toLowerCase()} {topic._count.references > 0 && `· ${topic._count.references} sources`}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 text-zinc-500">{formatDate(topic.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <CategoryManager categories={categories.map((c) => ({ key: c.key, name: c.name, description: c.description, enabled: c.enabled }))} />
      </div>
    </>
  );
}
