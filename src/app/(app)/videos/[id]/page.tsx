import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardTitle, PageHeader } from "@/components/ui/primitives";
import { ComponentEditor, MetadataEditor, SceneEditor, ScriptEditor } from "@/components/videos/editors";
import { LiveProgress } from "@/components/videos/live-progress";
import { VideoActions } from "@/components/videos/video-actions";
import { mediaUrl } from "@/components/videos/video-thumb";
import { requirePageUser } from "@/lib/auth";
import { getUserSettings } from "@/services/settings/settings-service";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { formatDate, formatDuration, formatUsd, isProcessing } from "@/lib/format";
import { MOOD_PROFILES } from "@/services/music/procedural";
import { videoDetails, type VideoDetails } from "@/services/videos/video-details";

export const metadata = { title: "Video" };

interface QualityReportView {
  passed: boolean;
  checkedAt: string;
  checks: { name: string; passed: boolean; detail: string }[];
}

export default async function VideoPage(props: PageProps<"/videos/[id]">) {
  const user = await requirePageUser();
  const { id } = await props.params;
  let details: VideoDetails;
  try {
    details = await videoDetails(user.id, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { video, steps, logs, scenes, voiceover, subtitle, voicePreset } = details;
  const [voices, tracks, youtubeAccounts] = await Promise.all([
    db.voicePreset.findMany({ where: { enabled: true, language: "en", provider: (await getUserSettings(user.id)).ttsProvider }, orderBy: { name: "asc" } }),
    db.musicTrack.findMany({ where: { enabled: true, OR: [{ userId: user.id }, { userId: null }] }, orderBy: { title: "asc" } }),
    db.youTubeAccount.count({ where: { userId: user.id, status: "ACTIVE" } }),
  ]);

  const processing = isProcessing(video.status);
  const uploaded = Boolean(video.youtubeVideoId);
  const renderUrl = mediaUrl(video.renderAsset?.storageKey);
  const thumbnailUrl = mediaUrl(video.thumbnailAsset?.storageKey);
  const downloadName = (video.title ?? video.topic?.title ?? "short").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "short";
  const script = video.script?.currentVersion;
  const quality = video.qualityReport as QualityReportView | null;
  const title = video.title ?? video.topic?.title ?? video.requestedTopic ?? "Automatic topic";

  return (
    <>
      <PageHeader
        title={title}
        description={`${video.category.replaceAll("_", " ")} · ${video.template?.name ?? "template"} · target ${video.targetDurationSec}s · created ${formatDate(video.createdAt)}`}
        actions={
          <Link href="/videos" className="text-sm text-zinc-400 hover:text-white">
            ← All videos
          </Link>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <div className="space-y-6">
          <Card className="p-3">
            {renderUrl ? (
              <video key={renderUrl} src={renderUrl} poster={thumbnailUrl ?? undefined} controls playsInline preload="metadata" className="aspect-[9/16] w-full rounded-lg bg-black" />
            ) : (
              <div className="flex aspect-[9/16] w-full items-center justify-center rounded-lg bg-zinc-900 text-sm text-zinc-500">
                {processing ? "Rendering preview soon..." : "No render yet"}
              </div>
            )}
            <div className="mt-3 space-y-2 px-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral">{formatDuration(video.actualDurationSec ?? voiceover?.durationSec ?? video.targetDurationSec)}</Badge>
                <Badge tone="neutral">1080×1920 · 30fps</Badge>
                <Badge tone="neutral">English</Badge>
                {video.youtubeUrl && (
                  <a href={video.youtubeUrl} target="_blank" rel="noreferrer">
                    <Badge tone="success">On YouTube ({video.youtubeStatus})</Badge>
                  </a>
                )}
              </div>
              <p className="text-xs text-zinc-500">Estimated cost: {formatUsd(video.costEstimateUsd)}</p>
              {renderUrl && (
                <div className="flex flex-wrap gap-3 pt-1">
                  <a href={renderUrl} download={`${downloadName}.mp4`} className="text-sm font-medium text-indigo-400 hover:text-indigo-300">
                    Download MP4
                  </a>
                  {thumbnailUrl && (
                    <a href={thumbnailUrl} download={`${downloadName}-thumbnail.jpg`} className="text-sm text-zinc-400 hover:text-white">
                      Download thumbnail
                    </a>
                  )}
                </div>
              )}
            </div>
          </Card>
          {thumbnailUrl && (
            <Card className="p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Thumbnail</p>
              {/* eslint-disable-next-line @next/next/no-img-element -- authenticated media route */}
              <img src={thumbnailUrl} alt="Thumbnail" className="aspect-[9/16] w-32 rounded object-cover" />
            </Card>
          )}
          <VideoActions videoId={video.id} status={video.status} uploaded={uploaded} youtubeConnected={youtubeAccounts > 0} />
        </div>

        <div className="space-y-6">
          <LiveProgress
            videoId={video.id}
            initialStatus={video.status}
            initialSteps={steps.map((s) => ({ step: s.step, label: s.label, status: s.status, progress: s.progress, error: s.error }))}
            initialLogs={logs.map((l) => ({ id: l.id, level: l.level, message: l.message, createdAt: l.createdAt.toISOString() }))}
            showPublishSteps={video.autoPublish || uploaded || video.status === "UPLOADING"}
          />

          {video.title && (
            <MetadataEditor
              videoId={video.id}
              disabled={processing || uploaded}
              initial={{
                title: video.title,
                description: video.description ?? "",
                hashtags: video.hashtags,
                tags: video.tags,
                thumbnailText: video.thumbnailText ?? "",
              }}
            />
          )}

          {script && <ScriptEditor videoId={video.id} text={script.fullText} estimatedSec={voiceover?.durationSec ?? script.estimatedDurationSec} targetSec={video.targetDurationSec} disabled={processing || uploaded} />}

          <ComponentEditor
            videoId={video.id}
            engine={(await getUserSettings(user.id)).ttsProvider}
            voices={voices.map((v) => ({ id: v.id, name: `${v.name}${v.description ? ` – ${v.description}` : ""}` }))}
            tracks={tracks.map((t) => ({ id: t.id, title: t.title, moods: t.moods }))}
            moods={Object.keys(MOOD_PROFILES)}
            disabled={processing || uploaded}
            current={{
              voicePresetId: video.voicePresetId ?? voicePreset?.id ?? null,
              voice: {
                speed: 1,
                stability: 0.45,
                similarityBoost: 0.8,
                style: 0.25,
                useSpeakerBoost: true,
                ...((voicePreset?.settings ?? {}) as object),
                ...((video.voiceSettings ?? {}) as object),
              },
              musicMode: video.musicMode,
              musicTrackId: video.musicMode === "manual" ? video.musicTrackId : null,
              privacy: video.privacy,
              scheduledPublishAt: video.scheduledPublishAt?.toISOString() ?? null,
              autoPublish: video.autoPublish,
            }}
          />

          <SceneEditor
            videoId={video.id}
            disabled={processing || uploaded}
            scenes={scenes.map((s) => ({
              id: s.id,
              index: s.index,
              startSec: s.startSec,
              endSec: s.endSec,
              narration: s.narration,
              visualDescription: s.visualDescription,
              keywords: s.keywords,
              locked: s.locked,
              mediaUrl: mediaUrl(s.mediaAsset?.storageKey),
              mediaKind: s.mediaAsset?.kind ?? null,
              author: s.mediaAsset?.author ?? null,
              sourceUrl: s.mediaAsset?.sourceUrl ?? null,
              candidates: s.candidates.map((c) => ({ id: c.id, previewImage: c.previewImage, author: c.author, kind: c.kind, width: c.width, height: c.height, durationSec: c.durationSec })),
            }))}
          />

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardTitle>Research</CardTitle>
              {video.topic?.researchSummary ? (
                <>
                  <p className="text-sm text-zinc-300">{video.topic.researchSummary}</p>
                  <ul className="mt-3 space-y-1 text-sm">
                    {video.topic.claims.slice(0, 8).map((claim) => (
                      <li key={claim.id} className="flex gap-2">
                        <Badge tone={claim.type === "ESTABLISHED_FACT" ? "success" : claim.type === "UNCERTAIN" ? "warning" : "neutral"}>{claim.type.replace("_", " ").toLowerCase()}</Badge>
                        <span className="text-zinc-300">{claim.statement}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">Sources</p>
                  <ul className="mt-1 space-y-1 text-xs">
                    {video.topic.references.map((ref) => (
                      <li key={ref.id}>
                        <a href={ref.url} target="_blank" rel="noreferrer" className="text-accent-300 hover:underline">
                          {ref.title}
                        </a>{" "}
                        <span className="text-zinc-600">({ref.publisher}, reliability {Math.round((ref.reliability ?? 0) * 100)}%)</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-sm text-zinc-500">{video.topic ? "Research not completed yet." : "Topic not selected yet."}</p>
              )}
            </Card>
            <Card>
              <CardTitle action={quality && <Badge tone={quality.passed ? "success" : "danger"}>{quality.passed ? "passed" : "failed"}</Badge>}>Quality control</CardTitle>
              {quality ? (
                <ul className="space-y-1 text-sm">
                  {quality.checks.map((check) => (
                    <li key={check.name} className="flex items-start gap-2">
                      <span className={check.passed ? "text-emerald-400" : "text-red-400"}>{check.passed ? "✓" : "✕"}</span>
                      <span className="text-zinc-300">{check.name.replaceAll("_", " ")}</span>
                      <span className="ml-auto text-right text-xs text-zinc-500">{check.detail}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-zinc-500">Runs after rendering.</p>
              )}
              {subtitle && (
                <p className="mt-4 text-xs text-zinc-500">
                  Subtitles: {(subtitle.cues as unknown[]).length} cues · style {subtitle.styleKey} · source {subtitle.provider} · language {subtitle.detectedLanguage ?? "en"}
                </p>
              )}
              {video.musicTrack && <p className="mt-1 text-xs text-zinc-500">Music: {video.musicTrack.title} ({video.musicTrack.license})</p>}
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
