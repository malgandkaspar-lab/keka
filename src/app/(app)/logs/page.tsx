import Link from "next/link";
import type { LogLevel, Prisma } from "@/generated/prisma/client";
import { Card, EmptyState, PageHeader, cn } from "@/components/ui/primitives";
import { requirePageUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDate, stepLabel } from "@/lib/format";

export const metadata = { title: "Logs" };

const LEVELS: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];

export default async function LogsPage(props: PageProps<"/logs">) {
  const user = await requirePageUser();
  const params = await props.searchParams;
  const level = typeof params.level === "string" && LEVELS.includes(params.level as LogLevel) ? (params.level as LogLevel) : null;
  const where: Prisma.SystemLogWhereInput = { userId: user.id, ...(level ? { level } : {}) };
  const logs = await db.systemLog.findMany({ where, orderBy: { createdAt: "desc" }, take: 300 });

  return (
    <>
      <PageHeader title="Logs" description="Structured events from every generation, upload and schedule (secrets are never logged)." />
      <div className="mb-4 flex flex-wrap gap-2">
        {[null, ...LEVELS.slice(1)].map((l) => (
          <Link
            key={l ?? "all"}
            href={l ? `/logs?level=${l}` : "/logs"}
            className={cn("rounded-full border px-3 py-1 text-sm", level === l ? "border-accent-500 bg-accent-500/15 text-white" : "border-zinc-800 text-zinc-400 hover:text-white")}
          >
            {l ?? "All"}
          </Link>
        ))}
      </div>
      {logs.length === 0 ? (
        <EmptyState title="No log entries" />
      ) : (
        <Card className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left font-mono text-xs">
              <thead className="border-b border-zinc-800 uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-4 py-2">Time</th>
                  <th className="px-2 py-2">Level</th>
                  <th className="px-2 py-2">Step</th>
                  <th className="px-2 py-2">Message</th>
                  <th className="px-2 py-2">Provider</th>
                  <th className="px-4 py-2 text-right">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900">
                {logs.map((log) => (
                  <tr key={log.id} className="align-top">
                    <td className="whitespace-nowrap px-4 py-2 text-zinc-500">{formatDate(log.createdAt)}</td>
                    <td className={cn("px-2 py-2", log.level === "ERROR" && "text-red-400", log.level === "WARN" && "text-amber-300", log.level === "INFO" && "text-zinc-400")}>{log.level}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-zinc-500">{log.step ? stepLabel(log.step) : "–"}</td>
                    <td className="px-2 py-2 text-zinc-200">
                      {log.videoId ? (
                        <Link href={`/videos/${log.videoId}`} className="hover:underline">
                          {log.message}
                        </Link>
                      ) : (
                        log.message
                      )}
                      {log.error && log.error !== log.message && <p className="mt-1 text-red-300/80">{log.error}</p>}
                    </td>
                    <td className="px-2 py-2 text-zinc-500">{log.provider ?? "–"}</td>
                    <td className="px-4 py-2 text-right text-zinc-500">{log.durationMs != null ? `${(log.durationMs / 1000).toFixed(1)}s` : "–"}</td>
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
