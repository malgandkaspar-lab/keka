import { ScheduleForm, ScheduleList } from "@/components/forms/schedule-form";
import { Alert, Card, CardTitle, EmptyState, PageHeader } from "@/components/ui/primitives";
import { requirePageUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata = { title: "Schedules" };

export default async function SchedulesPage() {
  const user = await requirePageUser();
  const [schedules, categories, voices, templates, youtube] = await Promise.all([
    db.schedule.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" }, include: { template: { select: { key: true } }, _count: { select: { videos: true } } } }),
    db.topicCategory.findMany({ where: { enabled: true }, orderBy: { sortOrder: "asc" } }),
    db.voicePreset.findMany({ where: { enabled: true, language: "en" }, orderBy: { name: "asc" } }),
    db.generationTemplate.findMany({ where: { enabled: true } }),
    db.youTubeAccount.count({ where: { userId: user.id, status: "ACTIVE" } }),
  ]);
  const options = {
    categories: categories.map((c) => ({ key: c.key, name: c.name })),
    voices: voices.map((v) => ({ id: v.id, name: v.name })),
    templates: templates.map((t) => ({ key: t.key, name: t.name })),
    youtubeConnected: youtube > 0,
  };

  return (
    <>
      <PageHeader title="Schedules · Auto mode" description="Generate, research, render and publish Shorts automatically on a schedule. Topics are chosen by the AI." />
      {!options.youtubeConnected && (
        <div className="mb-6">
          <Alert tone="info">Connect a YouTube channel to publish scheduled videos automatically. Without one, videos stop at READY.</Alert>
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        <div>
          {schedules.length === 0 ? (
            <EmptyState title="No schedules yet">Create one to turn on AUTO MODE.</EmptyState>
          ) : (
            <ScheduleList
              options={options}
              schedules={schedules.map((s) => ({
                id: s.id,
                name: s.name,
                enabled: s.enabled,
                daysOfWeek: s.daysOfWeek,
                times: s.times,
                timezone: s.timezone,
                videosPerRun: s.videosPerRun,
                categories: s.categories,
                voicePresetId: s.voicePresetId,
                templateKey: s.template?.key ?? null,
                durationSec: s.durationSec,
                musicMode: s.musicMode,
                privacy: s.privacy,
                autoPublish: s.autoPublish,
                publishDelayMin: s.publishDelayMin,
                nextRunAt: s.nextRunAt?.toISOString() ?? null,
                lastRunAt: s.lastRunAt?.toISOString() ?? null,
                videoCount: s._count.videos,
              }))}
            />
          )}
        </div>
        <Card>
          <CardTitle>New schedule</CardTitle>
          <ScheduleForm options={options} />
        </Card>
      </div>
    </>
  );
}
