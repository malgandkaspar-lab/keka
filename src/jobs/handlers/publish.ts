import { db } from "@/lib/db";
import { AuthenticationError, ValidationError } from "@/lib/errors";
import { validateBundle } from "@/services/language/language-service";
import { getStorage } from "@/services/storage";
import { clientForAccount, markAccountError, privacyForUpload, resolveAccountForVideo, youtubeUrl } from "@/services/youtube/youtube-service";
import { loadVideoContext } from "../context";
import type { StepHandler } from "../types";

/**
 * Publishing steps.
 *
 * youtube-upload: duplicate-safe resumable upload.
 *   - never uploads a video that already has a YouTube video ID
 *   - on retries, adopts an upload that reached YouTube but whose response was lost
 *   - runs a mandatory final English validation before sending anything
 * youtube-publish: sets the thumbnail and syncs privacy / schedule state.
 */
const RECENT_UPLOAD_WINDOW_MS = 3 * 60 * 60 * 1000;

export const youtubeUploadHandler: StepHandler = async (ctx) => {
  const { video, settings } = await loadVideoContext(ctx.videoId);
  if (video.youtubeVideoId) {
    return { message: `Already uploaded (${video.youtubeVideoId}); skipping duplicate upload`, output: { youtubeVideoId: video.youtubeVideoId, duplicatePrevented: true } };
  }
  if (!video.renderAssetId || !video.title || !video.description) throw new ValidationError("Video is not ready for upload");

  // Mandatory English gate - nothing non-English is ever uploaded.
  const english = validateBundle({ title: video.title, description: video.description.split(/\n\nCredits:/)[0], hashtags: video.hashtags, tags: video.tags, thumbnail: video.thumbnailText });
  if (!english.passed) throw new ValidationError(`Upload blocked: non-English metadata (${english.failedFields.join(", ")})`);

  const account = await resolveAccountForVideo(video);
  const { privacyStatus, publishAt } = privacyForUpload(video.privacy, video.scheduledPublishAt);
  const publishJob =
    (await db.publishJob.findFirst({ where: { videoId: video.id, status: { in: ["PENDING", "UPLOADING", "FAILED"] } }, orderBy: { createdAt: "desc" } })) ??
    (await db.publishJob.create({ data: { videoId: video.id, youtubeAccountId: account.id, privacy: video.privacy, publishAt } }));
  await db.publishJob.update({
    where: { id: publishJob.id },
    data: { status: "UPLOADING", attempts: { increment: 1 }, startedAt: publishJob.startedAt ?? new Date(), error: null },
  });

  try {
    const client = await clientForAccount(account);

    if (ctx.attempt > 1 || publishJob.attempts > 0) {
      const since = Date.now() - RECENT_UPLOAD_WINDOW_MS;
      const recent = await client.listRecentUploads(15);
      const match = recent.find((u) => u.title === video.title && (!u.publishedAt || Date.parse(u.publishedAt) > since));
      if (match) {
        await saveUpload(video.id, publishJob.id, match.videoId, account.id);
        await ctx.log(`Found the previous upload on YouTube (${match.videoId}); not uploading again`, { level: "WARN", provider: "youtube" });
        return { provider: "youtube", message: `Upload recovered: ${youtubeUrl(match.videoId)}`, output: { youtubeVideoId: match.videoId, recovered: true } };
      }
    }

    const render = await db.mediaAsset.findUniqueOrThrow({ where: { id: video.renderAssetId } });
    const storage = getStorage();
    const stat = await storage.stat(render.storageKey);
    const media = await storage.createReadStream(render.storageKey);
    await ctx.progress(5, "Uploading to YouTube");
    const uploaded = await client.upload({
      title: video.title,
      description: video.description,
      tags: video.tags,
      categoryId: settings.youtubeCategoryId,
      privacyStatus,
      publishAt,
      containsSyntheticMedia: true,
      media,
      mediaSizeBytes: stat?.sizeBytes,
      onProgress: (fraction) => void ctx.progress(Math.round(5 + fraction * 90), "Uploading to YouTube"),
    });
    await saveUpload(video.id, publishJob.id, uploaded.videoId, account.id);
    return {
      provider: "youtube",
      message: `Uploaded to YouTube as ${uploaded.privacyStatus}: ${youtubeUrl(uploaded.videoId)}`,
      output: { youtubeVideoId: uploaded.videoId, privacyStatus: uploaded.privacyStatus, publishAt: uploaded.publishAt },
    };
  } catch (error) {
    await db.publishJob.update({ where: { id: publishJob.id }, data: { status: "FAILED", error: (error as Error).message.slice(0, 1000) } });
    if (error instanceof AuthenticationError) await markAccountError(account.id, error);
    throw error;
  }
};

async function saveUpload(videoId: string, publishJobId: string, youtubeVideoId: string, accountId: string): Promise<void> {
  await db.$transaction([
    db.video.update({
      where: { id: videoId },
      data: { youtubeVideoId, youtubeUrl: youtubeUrl(youtubeVideoId), youtubeAccountId: accountId, uploadedAt: new Date(), youtubeStatus: "uploaded" },
    }),
    db.publishJob.update({ where: { id: publishJobId }, data: { status: "UPLOADED", youtubeVideoId } }),
  ]);
}

export const youtubePublishHandler: StepHandler = async (ctx) => {
  const { video } = await loadVideoContext(ctx.videoId);
  if (!video.youtubeVideoId) throw new ValidationError("Video has not been uploaded");
  const account = await resolveAccountForVideo(video);
  const client = await clientForAccount(account);
  const publishJob = await db.publishJob.findFirst({ where: { videoId: video.id, youtubeVideoId: video.youtubeVideoId }, orderBy: { createdAt: "desc" } });

  let thumbnail = "skipped";
  if (video.thumbnailAssetId) {
    try {
      const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id: video.thumbnailAssetId } });
      await client.setThumbnail(video.youtubeVideoId, await getStorage().download(asset.storageKey), "image/jpeg");
      thumbnail = "set";
    } catch (error) {
      thumbnail = "failed";
      await ctx.log(`Custom thumbnail not applied: ${(error as Error).message} (channels need phone verification for custom thumbnails)`, { level: "WARN", provider: "youtube" });
    }
  }

  // Apply a privacy/schedule change made after upload.
  const desired = video.privacy === "SCHEDULED" ? "private" : video.privacy.toLowerCase();
  const status = await client.getVideoStatus(video.youtubeVideoId);
  if (!status) throw new ValidationError("The uploaded video no longer exists on YouTube");
  if (status.uploadStatus === "rejected" || status.uploadStatus === "failed") {
    throw new ValidationError(`YouTube ${status.uploadStatus} the video: ${status.rejectionReason ?? status.failureReason ?? "unknown reason"}`);
  }
  const scheduleChanged = video.privacy === "SCHEDULED" && video.scheduledPublishAt && status.publishAt !== video.scheduledPublishAt.toISOString();
  if (status.privacyStatus !== desired || scheduleChanged) {
    const { privacyStatus, publishAt } = privacyForUpload(video.privacy, video.scheduledPublishAt);
    await client.updatePrivacy(video.youtubeVideoId, privacyStatus, publishAt);
  }

  const scheduled = video.privacy === "SCHEDULED" && video.scheduledPublishAt && video.scheduledPublishAt.getTime() > Date.now();
  await db.video.update({
    where: { id: video.id },
    data: {
      status: scheduled ? "SCHEDULED" : "PUBLISHED",
      youtubeStatus: scheduled ? `scheduled for ${video.scheduledPublishAt!.toISOString()}` : desired,
      publishedAt: scheduled ? null : new Date(),
    },
  });
  if (publishJob) {
    await db.publishJob.update({ where: { id: publishJob.id }, data: { status: scheduled ? "SCHEDULED" : "PUBLISHED", completedAt: new Date() } });
  }
  return {
    provider: "youtube",
    message: scheduled ? `Scheduled on YouTube for ${video.scheduledPublishAt!.toISOString()}` : `Published on YouTube (${desired})`,
    output: { thumbnail, privacy: desired, scheduled: Boolean(scheduled) },
  };
};
