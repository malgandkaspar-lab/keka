/**
 * Real-world end-to-end validation (uses the REAL configured providers - costs money).
 *
 *   npm run e2e:real -- --email you@example.com [--topic "Why do astronauts grow taller in space?"] [--upload]
 *
 * Runs the full pipeline in this process (its own BullMQ workers) against the configured
 * database, Redis, Claude, ElevenLabs, Pexels and FFmpeg, then prints a validation
 * report: English script, English voiceover, multiple visual assets, subtitles, a
 * 1080x1920 MP4 with valid audio, English metadata. With --upload (and a connected
 * channel) the video is uploaded as PRIVATE - never public.
 */
import "dotenv/config";
import path from "node:path";
import { Worker, type Job } from "bullmq";
import { credentialStatus } from "@/config/env";
import { db, disconnectDb } from "@/lib/db";
import { closeRedis, createRedisConnection } from "@/lib/redis";
import { processStepJob } from "@/jobs/runner";
import { closeQueues, type StepJobData } from "@/queues";
import { validateBundle } from "@/services/language/language-service";
import { materialize } from "@/services/storage";
import { mediaInfo } from "@/services/video/ffmpeg";
import { createVideo } from "@/services/videos/video-service";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const creds = credentialStatus();
  const missing = [
    !creds.anthropic && "ANTHROPIC_API_KEY",
    !creds.elevenlabs && "ELEVENLABS_API_KEY",
    !creds.pexels && "PEXELS_API_KEY",
  ].filter(Boolean);
  if (missing.length) {
    console.error(`Missing credentials: ${missing.join(", ")}. Set them in .env to run the real end-to-end test.`);
    return 2;
  }
  const email = arg("email");
  const user = email ? await db.user.findUnique({ where: { email } }) : await db.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } });
  if (!user) {
    console.error("No user found. Register in the web app first, or pass --email.");
    return 2;
  }
  const upload = process.argv.includes("--upload");
  const account = upload ? await db.youTubeAccount.findFirst({ where: { userId: user.id, status: "ACTIVE" } }) : null;
  if (upload && !account) console.warn("No connected YouTube channel - skipping the upload step.");

  const processor = (job: Job<StepJobData>) => processStepJob(job);
  const workers = ["pipeline", "render", "publish"].map((name) => new Worker<StepJobData>(name, processor, { connection: createRedisConnection(), concurrency: 1 }));

  const topic = arg("topic") ?? "Why do astronauts grow taller in space?";
  console.log(`Generating: "${topic}" for ${user.email}${account ? ` (upload as PRIVATE to ${account.channelTitle})` : ""}`);
  const { video } = await createVideo(user.id, { topic, category: arg("category") ?? "space", durationSec: Number(arg("duration") ?? 30), privacy: "PRIVATE", autoPublish: Boolean(account) });

  let lastLog = new Date(0);
  let final = video;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const logs = await db.systemLog.findMany({ where: { videoId: video.id, createdAt: { gt: lastLog } }, orderBy: { createdAt: "asc" } });
    for (const log of logs) console.log(`${log.createdAt.toISOString().slice(11, 19)} ${log.level.padEnd(5)} ${log.message}`);
    if (logs.length) lastLog = logs.at(-1)!.createdAt;
    final = await db.video.findUniqueOrThrow({ where: { id: video.id } });
    if (["READY", "PUBLISHED", "SCHEDULED", "FAILED", "CANCELLED"].includes(final.status) && !(account && final.status === "READY")) break;
  }
  await Promise.all(workers.map((w) => w.close()));

  console.log(`\nFinal status: ${final.status}${final.error ? ` - ${final.error}` : ""}`);
  if (final.status === "FAILED" || final.status === "CANCELLED") return 1;

  const script = await db.script.findUnique({ where: { videoId: video.id }, include: { currentVersion: true } });
  const scenes = await db.videoScene.findMany({ where: { videoId: video.id }, include: { mediaAsset: true } });
  const subtitle = await db.subtitle.findFirst({ where: { videoId: video.id, isCurrent: true } });
  const voice = await db.voiceover.findFirst({ where: { videoId: video.id, isCurrent: true } });
  const render = await db.mediaAsset.findUniqueOrThrow({ where: { id: final.renderAssetId! } });
  const info = await mediaInfo(await materialize(render.storageKey, path.resolve("storage/tmp")));
  const english = validateBundle({ script: script?.currentVersion?.fullText, title: final.title, description: final.description?.split(/\n\nCredits:/)[0], hashtags: final.hashtags, subtitles: subtitle?.transcript });

  const report = {
    script: script?.currentVersion?.fullText,
    voiceover: { durationSec: voice?.durationSec, voice: voice?.voiceName },
    visualAssets: new Set(scenes.map((s) => s.mediaAssetId)).size,
    subtitles: { cues: (subtitle?.cues as unknown[] | undefined)?.length ?? 0, language: subtitle?.detectedLanguage },
    render: { key: render.storageKey, ...info },
    metadata: { title: final.title, hashtags: final.hashtags },
    englishValidation: english.passed ? "passed" : `FAILED: ${english.failedFields.join(", ")}`,
    youtube: final.youtubeUrl ?? "not uploaded",
    estimatedCostUsd: final.costEstimateUsd,
  };
  console.log(JSON.stringify(report, null, 2));
  const ok = info.width === 1080 && info.height === 1920 && info.hasAudio && english.passed && report.visualAssets > 1;
  console.log(ok ? "\nREAL END-TO-END VALIDATION PASSED" : "\nREAL END-TO-END VALIDATION FAILED");
  return ok ? 0 : 1;
}

main()
  .then(async (code) => {
    await closeQueues();
    await closeRedis();
    await disconnectDb();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error);
    process.exit(1);
  });
