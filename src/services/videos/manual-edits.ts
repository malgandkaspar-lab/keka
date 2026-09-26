import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ConflictError, LanguageValidationError, NotFoundError, ValidationError } from "@/lib/errors";
import { getVideoProvider } from "@/services/footage";
import { downloadCandidate, searchSceneFootage } from "@/services/footage/footage-service";
import type { FootageCandidate } from "@/services/footage/types";
import { analyzeLanguage, analyzeList } from "@/services/language/language-service";
import { logEvent } from "@/services/logging/system-log";
import { sanitizeMetadata } from "@/services/metadata/metadata-service";
import { activeJob, regenerate } from "@/services/pipeline/orchestrator";
import { assertContentAllowed } from "@/services/policy/content-policy";
import { draftFromManualText, saveScriptVersion } from "@/services/scripts/script-service";
import { getStorage } from "@/services/storage";
import { getUserSettings } from "@/services/settings/settings-service";

/**
 * Manual overrides. The system is automated, but every generated component can be
 * edited by hand; each edit re-runs only the steps that depend on it.
 */
async function editableVideo(userId: string, videoId: string) {
  const video = await db.video.findFirst({ where: { id: videoId, userId } });
  if (!video) throw new NotFoundError("Video", videoId);
  if (await activeJob(videoId)) throw new ConflictError("Wait for the current step to finish (or cancel it) before editing.");
  return video;
}

export const metadataEditSchema = z.object({
  title: z.string().trim().min(3).max(100),
  description: z.string().trim().min(10).max(5000),
  hashtags: z.array(z.string().max(60)).max(15),
  tags: z.array(z.string().max(60)).max(40),
  thumbnailText: z.string().trim().max(60).nullable().optional(),
});

export async function editMetadata(userId: string, videoId: string, input: unknown) {
  const video = await editableVideo(userId, videoId);
  if (video.youtubeVideoId) throw new ConflictError("Metadata cannot be changed here after upload; edit it in YouTube Studio.");
  const parsed = metadataEditSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid metadata");
  const cleaned = sanitizeMetadata({ ...parsed.data, thumbnailText: parsed.data.thumbnailText ?? "" });
  // English-only is enforced for manual edits too.
  const reasons: string[] = [];
  for (const [field, value, kind] of [["title", cleaned.title, "title"], ["description", cleaned.description.split(/\n\nCredits:/)[0] ?? "", "description"], ["thumbnail text", cleaned.thumbnailText, "thumbnail"]] as const) {
    if (value) {
      const analysis = analyzeLanguage(value, kind);
      if (!analysis.isEnglish) reasons.push(`${field}: ${analysis.reasons.join("; ")}`);
    }
  }
  if (cleaned.hashtags.length && !analyzeList(cleaned.hashtags, "hashtags").isEnglish) reasons.push("hashtags are not English");
  if (cleaned.tags.length && !analyzeList(cleaned.tags, "tags").isEnglish) reasons.push("tags are not English");
  if (reasons.length) throw new LanguageValidationError("metadata", reasons, false);
  assertContentAllowed(`${cleaned.title} ${cleaned.description}`, "metadata");

  const thumbnailChanged = (video.thumbnailText ?? "") !== cleaned.thumbnailText;
  await db.video.update({
    where: { id: video.id },
    data: { title: cleaned.title, description: cleaned.description, hashtags: cleaned.hashtags, tags: cleaned.tags, thumbnailText: cleaned.thumbnailText || null, metadataLocked: true },
  });
  await logEvent({ userId, videoId, message: "Metadata edited manually" });
  if (video.renderAssetId) await regenerate(video.id, thumbnailChanged ? "GENERATE_THUMBNAIL" : "GENERATE_METADATA");
}

export async function editScript(userId: string, videoId: string, text: string) {
  const video = await editableVideo(userId, videoId);
  if (video.youtubeVideoId) throw new ConflictError("This video is already on YouTube.");
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length < 40) throw new ValidationError("The script is too short");
  const analysis = analyzeLanguage(trimmed, "script");
  if (!analysis.isEnglish) throw new LanguageValidationError("script", analysis.reasons, false);
  assertContentAllowed(trimmed, "script");
  const settings = await getUserSettings(userId);
  await saveScriptVersion({ videoId, draft: draftFromManualText(trimmed), source: "MANUAL", targetDurationSec: video.targetDurationSec, wordsPerMinute: settings.wordsPerMinute });
  await logEvent({ userId, videoId, message: "Script edited manually" });
  await regenerate(video.id, "VALIDATE_SCRIPT");
}

export const componentEditSchema = z.object({
  voicePresetId: z.string().uuid().optional(),
  voiceSettings: z
    .object({
      stability: z.number().min(0).max(1).optional(),
      similarityBoost: z.number().min(0).max(1).optional(),
      style: z.number().min(0).max(1).optional(),
      speed: z.number().min(0.7).max(1.2).optional(),
      useSpeakerBoost: z.boolean().optional(),
    })
    .optional(),
  musicMode: z.string().max(40).optional(),
  musicTrackId: z.string().uuid().nullable().optional(),
  privacy: z.enum(["PRIVATE", "UNLISTED", "PUBLIC", "SCHEDULED"]).optional(),
  scheduledPublishAt: z.coerce.date().nullable().optional(),
  autoPublish: z.boolean().optional(),
  sfxEnabled: z.boolean().optional(),
  applyNow: z.boolean().default(true),
});

/** Voice / music / publishing changes. Voice or music changes re-run from that step. */
export async function editComponents(userId: string, videoId: string, input: unknown) {
  const parsed = componentEditSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid changes");
  const data = parsed.data;
  const voiceChanged = data.voicePresetId !== undefined || data.voiceSettings !== undefined;
  const musicChanged = data.musicMode !== undefined || data.musicTrackId !== undefined || data.sfxEnabled !== undefined;
  const video = voiceChanged || musicChanged ? await editableVideo(userId, videoId) : await db.video.findFirst({ where: { id: videoId, userId } });
  if (!video) throw new NotFoundError("Video", videoId);

  if (data.voicePresetId) {
    const voice = await db.voicePreset.findUnique({ where: { id: data.voicePresetId } });
    if (!voice || voice.language !== "en" || !voice.enabled) throw new ValidationError("Choose an enabled English voice");
  }
  if (data.musicTrackId) {
    const track = await db.musicTrack.findFirst({ where: { id: data.musicTrackId, enabled: true, OR: [{ userId }, { userId: null }] } });
    if (!track) throw new ValidationError("Unknown music track");
  }
  if (data.privacy === "SCHEDULED" && !(data.scheduledPublishAt ?? video.scheduledPublishAt)) {
    throw new ValidationError("Choose a publish date/time for scheduled videos");
  }

  await db.video.update({
    where: { id: video.id },
    data: {
      ...(data.voicePresetId !== undefined ? { voicePresetId: data.voicePresetId } : {}),
      ...(data.voiceSettings !== undefined ? { voiceSettings: data.voiceSettings as Prisma.InputJsonValue } : {}),
      ...(data.musicTrackId !== undefined ? { musicTrackId: data.musicTrackId, musicMode: data.musicTrackId ? "manual" : (data.musicMode ?? "none") } : {}),
      ...(data.musicMode !== undefined && data.musicTrackId === undefined ? { musicMode: data.musicMode } : {}),
      ...(data.sfxEnabled !== undefined ? { sfxEnabled: data.sfxEnabled } : {}),
      ...(data.privacy !== undefined ? { privacy: data.privacy } : {}),
      ...(data.scheduledPublishAt !== undefined ? { scheduledPublishAt: data.scheduledPublishAt } : {}),
      ...(data.autoPublish !== undefined ? { autoPublish: data.autoPublish } : {}),
    },
  });
  if (data.applyNow && video.renderAssetId && !video.youtubeVideoId) {
    if (voiceChanged) await regenerate(video.id, "GENERATE_VOICE");
    else if (musicChanged) await regenerate(video.id, "SELECT_MUSIC");
  }
}

/** Scene editor: search replacement footage, or pick a candidate for a scene. */
export async function searchSceneReplacement(userId: string, videoId: string, sceneId: string, query: string) {
  const scene = await db.videoScene.findFirst({ where: { id: sceneId, videoId, video: { userId } } });
  if (!scene) throw new NotFoundError("Scene", sceneId);
  const q = query.trim().toLowerCase();
  if (!q || !analyzeList([q], "tags").isEnglish) throw new ValidationError("Use an English search query");
  const settings = await getUserSettings(userId);
  const result = await searchSceneFootage({
    provider: getVideoProvider(),
    keywords: [q],
    fallbackKeywords: [],
    videoFallbackKeywords: [],
    allowImages: settings.imageFallbackEnabled,
  });
  await db.videoScene.update({
    where: { id: scene.id },
    data: { keywords: [q, ...scene.keywords.filter((k) => k !== q)].slice(0, 5), candidates: result.candidates as unknown as Prisma.InputJsonValue },
  });
  return result.candidates;
}

export async function replaceSceneFootage(userId: string, videoId: string, sceneId: string, candidateId: string) {
  await editableVideo(userId, videoId);
  const scene = await db.videoScene.findFirst({ where: { id: sceneId, videoId, video: { userId } } });
  if (!scene) throw new NotFoundError("Scene", sceneId);
  const candidate = ((scene.candidates as unknown as FootageCandidate[]) ?? []).find((c) => c.id === candidateId);
  if (!candidate) throw new ValidationError("Candidate not found for this scene; search again");
  const asset = await downloadCandidate({ provider: getVideoProvider(), candidate, userId });
  await db.videoScene.update({ where: { id: scene.id }, data: { mediaAssetId: asset.id, locked: true } });
  await logEvent({ userId, videoId, message: `Scene ${scene.index + 1} footage replaced manually (${candidate.author}, Pexels)` });
}

export async function deleteVideo(userId: string, videoId: string) {
  const video = await db.video.findFirst({ where: { id: videoId, userId } });
  if (!video) throw new NotFoundError("Video", videoId);
  if (await activeJob(videoId)) throw new ConflictError("Cancel processing before deleting this video");
  const privateAssets = await db.mediaAsset.findMany({
    where: {
      OR: [
        { renderFor: { some: { id: videoId } } },
        { thumbnailFor: { some: { id: videoId } } },
        { storageKey: { startsWith: `videos/${videoId}/` } },
      ],
    },
  });
  await db.video.delete({ where: { id: videoId } });
  const storage = getStorage();
  for (const asset of privateAssets) {
    await storage.delete(asset.storageKey).catch(() => undefined);
    await db.mediaAsset.delete({ where: { id: asset.id } }).catch(() => undefined);
  }
}
