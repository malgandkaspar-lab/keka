import type { JobStatus } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import type { FootageCandidate } from "@/services/footage/types";
import { ALL_STEPS, STEP_DEFINITIONS } from "@/services/pipeline/steps";

/** Everything the video detail page needs, in a serialisable shape. */
export async function videoDetails(userId: string, videoId: string) {
  const video = await db.video.findFirst({
    where: { id: videoId, userId },
    include: {
      topic: { include: { references: { orderBy: { reliability: "desc" } }, claims: true } },
      template: { select: { key: true, name: true } },
      renderAsset: true,
      thumbnailAsset: true,
      musicTrack: true,
      script: { include: { currentVersion: true, versions: { orderBy: { version: "desc" }, take: 10 } } },
      scenes: { orderBy: { index: "asc" }, include: { mediaAsset: true } },
      voiceovers: { where: { isCurrent: true }, include: { asset: true }, take: 1 },
      subtitles: { where: { isCurrent: true }, take: 1 },
      jobs: { orderBy: { createdAt: "asc" } },
      publishJobs: { orderBy: { createdAt: "desc" }, take: 5 },
      analytics: { orderBy: { capturedAt: "desc" }, take: 1 },
    },
  });
  if (!video) throw new NotFoundError("Video", videoId);
  const logs = await db.systemLog.findMany({ where: { videoId }, orderBy: { createdAt: "asc" }, take: 500 });
  const voicePreset = video.voicePresetId ? await db.voicePreset.findUnique({ where: { id: video.voicePresetId } }) : null;

  const latestJobs = new Map<string, (typeof video.jobs)[number]>();
  for (const job of video.jobs) latestJobs.set(job.step, job);
  const steps = ALL_STEPS.map((step) => {
    const job = latestJobs.get(step);
    return {
      step,
      label: STEP_DEFINITIONS[step].label,
      status: (job?.status ?? "PENDING") as JobStatus | "PENDING",
      progress: job?.progress ?? 0,
      attempts: job?.attempts ?? 0,
      durationMs: job?.durationMs ?? null,
      error: job?.error ?? null,
      output: job?.output ?? null,
    };
  });

  return {
    video,
    steps,
    logs,
    voicePreset,
    scenes: video.scenes.map((scene) => ({
      ...scene,
      candidates: ((scene.candidates as unknown as FootageCandidate[]) ?? []).slice(0, 12),
    })),
    voiceover: video.voiceovers[0] ?? null,
    subtitle: video.subtitles[0] ?? null,
  };
}

export type VideoDetails = Awaited<ReturnType<typeof videoDetails>>;
