import { z } from "zod";
import type { PrivacyStatus, Video } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { assertWithinLimits } from "@/services/cost/limits-service";
import { logEvent } from "@/services/logging/system-log";
import { markStepSkipped, startOrResume } from "@/services/pipeline/orchestrator";
import { getUserSettings } from "@/services/settings/settings-service";
import { createManualTopic } from "@/services/topics/topic-service";

/**
 * VideoService - creating videos and starting their generation pipeline.
 * Validates input, enforces cost limits, resolves defaults from settings and records
 * the manual topic (English + policy checked) when one is supplied.
 */
export const createVideoSchema = z
  .object({
    topic: z.string().trim().max(200).optional().nullable(),
    autoTopic: z.boolean().default(false),
    category: z.string().min(1).optional(),
    durationSec: z.number().int().min(10).max(180).optional(),
    voicePresetId: z.string().uuid().optional().nullable(),
    templateKey: z.string().min(1).optional(),
    musicMode: z.string().min(1).max(40).optional(),
    privacy: z.enum(["PRIVATE", "UNLISTED", "PUBLIC", "SCHEDULED"]).optional(),
    autoPublish: z.boolean().optional(),
    scheduledPublishAt: z.coerce.date().optional().nullable(),
    youtubeAccountId: z.string().uuid().optional().nullable(),
    channelId: z.string().uuid().optional().nullable(),
  })
  .refine((v) => v.autoTopic || (v.topic && v.topic.length >= 8), {
    message: "Enter a topic (at least 8 characters) or enable automatic topic generation",
    path: ["topic"],
  })
  .refine((v) => v.privacy !== "SCHEDULED" || v.scheduledPublishAt, {
    message: "Choose a publish date/time for scheduled videos",
    path: ["scheduledPublishAt"],
  });

export type CreateVideoInput = z.input<typeof createVideoSchema>;

export async function createVideo(userId: string, input: CreateVideoInput, options: { scheduleId?: string; start?: boolean } = {}): Promise<{ video: Video; similarTopic: string | null }> {
  const parsed = createVideoSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input", { issues: parsed.error.issues });
  const data = parsed.data;
  const settings = await getUserSettings(userId);
  await assertWithinLimits(userId, settings);

  const project = await db.project.findFirst({ where: { userId }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  if (!project) throw new NotFoundError("Project");
  const category = data.category ?? settings.defaultCategory;
  const templateKey = data.templateKey ?? settings.defaultTemplateKey;
  const template = await db.generationTemplate.findUnique({ where: { key: templateKey } });
  if (!template || !template.enabled) throw new ValidationError(`Unknown video style "${templateKey}"`);
  const voicePresetId = data.voicePresetId ?? settings.defaultVoicePresetId;
  if (voicePresetId) {
    const voice = await db.voicePreset.findUnique({ where: { id: voicePresetId } });
    if (!voice || !voice.enabled || voice.language !== "en") throw new ValidationError("Choose an enabled English voice");
  }

  let topicId: string | null = null;
  let similarTopic: string | null = null;
  if (!data.autoTopic && data.topic) {
    const manual = await createManualTopic({ userId, projectId: project.id, title: data.topic, categoryKey: category, similarityThreshold: settings.topicSimilarityThreshold });
    topicId = manual.topic.id;
    similarTopic = manual.similarTo;
  }

  const privacy: PrivacyStatus = data.privacy ?? settings.defaultPrivacy;
  const video = await db.video.create({
    data: {
      userId,
      projectId: project.id,
      channelId: data.channelId ?? null,
      topicId,
      templateId: template.id,
      scheduleId: options.scheduleId ?? null,
      requestedTopic: data.topic ?? null,
      autoTopic: data.autoTopic,
      category,
      targetDurationSec: data.durationSec ?? settings.defaultDurationSec,
      voicePresetId: voicePresetId ?? null,
      musicMode: data.musicMode ?? settings.defaultMusicMode,
      privacy,
      scheduledPublishAt: privacy === "SCHEDULED" ? (data.scheduledPublishAt ?? null) : null,
      autoPublish: data.autoPublish ?? settings.autoPublish,
      youtubeAccountId: data.youtubeAccountId ?? null,
      sfxEnabled: settings.sfxEnabled,
    },
  });
  if (topicId) await markStepSkipped(video.id, userId, "GENERATE_TOPIC", "manual topic");
  await logEvent({
    userId,
    videoId: video.id,
    message: data.autoTopic ? `Video created (automatic topic, ${category})` : `Video created: "${data.topic}"`,
    context: { durationSec: video.targetDurationSec, template: templateKey, privacy },
  });
  if (similarTopic) {
    await logEvent({ level: "WARN", userId, videoId: video.id, message: `This topic is similar to an earlier one: "${similarTopic}"` });
  }
  if (options.start !== false) await startOrResume(video.id);
  return { video, similarTopic };
}

export async function getOwnedVideo(userId: string, videoId: string) {
  const video = await db.video.findFirst({ where: { id: videoId, userId } });
  if (!video) throw new NotFoundError("Video", videoId);
  return video;
}
