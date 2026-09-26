import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { Worker, type Job } from "bullmq";
import { db, disconnectDb } from "@/lib/db";
import { closeRedis, createRedisConnection, getRedis } from "@/lib/redis";
import { encryptSecret } from "@/lib/crypto";
import { closeQueues, getQueue, QUEUE_NAMES, type StepJobData } from "@/queues";
import { processStepJob } from "@/jobs/runner";
import { setAIProviderForTesting } from "@/services/ai";
import { setVideoProviderForTesting } from "@/services/footage";
import { setSpeechProvidersForTesting } from "@/services/tts";
import { setYouTubeProviderForTesting } from "@/services/youtube/youtube-service";
import { createVideo } from "@/services/videos/video-service";
import { regenerate, requestPublish, startOrResume } from "@/services/pipeline/orchestrator";
import { reconcilePipeline } from "@/services/pipeline/recovery";
import { getStorage } from "@/services/storage";
import { mediaInfo } from "@/services/video/ffmpeg";
import { materialize } from "@/services/storage";
import { updateUserSettings } from "@/services/settings/settings-service";
import { collectAnalyticsForUser } from "@/services/analytics/analytics-service";
import { createTestUser, resetDatabase } from "../helpers/db";
import { ASTRONAUT_SCRIPT, FakeAIProvider, FakeSTTProvider, FakeTTSProvider, FakeVideoProvider, FakeYouTubeProvider } from "../helpers/fakes";
import { fullText } from "@/services/scripts/script-service";
import { KokoroTTSProvider } from "@/services/tts/kokoro";
import { ParakeetSTTProvider } from "@/services/tts/parakeet";
import { isModelInstalled, LOCAL_MODELS } from "@/services/local-ai/models";
import { wordErrorRate } from "@/services/tts/alignment";

const localModels = (await isModelInstalled(LOCAL_MODELS["kokoro-en"])) && (await isModelInstalled(LOCAL_MODELS["parakeet-en"]));

/**
 * End-to-end pipeline test: real PostgreSQL, real BullMQ/Redis queues and workers,
 * real FFmpeg rendering and quality control. Only paid external APIs are faked.
 */
let workers: Worker[] = [];
const ai = new FakeAIProvider();
const tts = new FakeTTSProvider();
const stt = new FakeSTTProvider(() => fullText(ASTRONAUT_SCRIPT));
const footage = new FakeVideoProvider();
const youtube = new FakeYouTubeProvider();

async function waitForStatus(videoId: string, statuses: string[], timeoutMs = 240_000) {
  const started = Date.now();
  for (;;) {
    const video = await db.video.findUniqueOrThrow({ where: { id: videoId } });
    if (statuses.includes(video.status)) return video;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${statuses.join("/")}; video is ${video.status} (${video.error ?? ""})`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

beforeAll(async () => {
  await getRedis().flushdb();
  setAIProviderForTesting(ai);
  setSpeechProvidersForTesting(tts, stt);
  setVideoProviderForTesting(footage);
  setYouTubeProviderForTesting(youtube);
  const processor = (job: Job<StepJobData>) => processStepJob(job);
  workers = ["pipeline", "render", "publish"].map(
    (name) => new Worker<StepJobData>(name, processor, { connection: createRedisConnection(), concurrency: 2 }),
  );
});

beforeEach(async () => {
  await resetDatabase();
  ai.calls = {};
  tts.calls = 0;
  footage.failDownloads = false;
});

afterEach(async () => {
  for (const name of QUEUE_NAMES) await getQueue(name).drain(true);
});

afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  await closeRedis();
  await disconnectDb();
  setAIProviderForTesting(undefined);
  setSpeechProvidersForTesting();
  setVideoProviderForTesting(undefined);
  setYouTubeProviderForTesting(undefined);
  if (!process.env.KEEP_TEST_MEDIA) await rm("./storage/test", { recursive: true, force: true });
});

async function connectFakeYouTube(userId: string) {
  return db.youTubeAccount.create({
    data: {
      userId,
      googleChannelId: "UC_fake_channel",
      channelTitle: "Fake Channel",
      accessTokenEnc: encryptSecret("fake-access"),
      refreshTokenEnc: encryptSecret("fake-refresh"),
      scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/yt-analytics.readonly"],
      isDefault: true,
    },
  });
}

describe("generation pipeline (end to end)", () => {
  it("turns a topic into a valid 1080x1920 Short and uploads it once as PRIVATE", async () => {
    const user = await createTestUser();
    await connectFakeYouTube(user.id);
    await updateUserSettings(user.id, { researchEnabled: true });
    const voice = await db.voicePreset.findFirstOrThrow({ where: { language: "en" } });

    const { video } = await createVideo(user.id, {
      topic: "Why do astronauts grow taller in space?",
      category: "space",
      durationSec: 30,
      voicePresetId: voice.id,
      templateKey: "fast_viral",
      privacy: "PRIVATE",
      autoPublish: true,
    });

    const done = await waitForStatus(video.id, ["PUBLISHED", "FAILED"]);
    expect(done.error).toBeNull();
    expect(done.status).toBe("PUBLISHED");

    // Every generation step completed exactly once.
    const jobs = await db.generationJob.findMany({ where: { videoId: video.id }, orderBy: { createdAt: "asc" } });
    const completed = jobs.filter((j) => j.status === "COMPLETED").map((j) => j.step);
    expect(new Set(completed).size).toBe(completed.length);
    expect(completed).toContain("RENDER_VIDEO");
    expect(completed).toContain("CONTENT_QA");
    expect(completed).toContain("YOUTUBE_PUBLISH");

    // Real MP4 output that satisfies the Shorts format.
    const render = await db.mediaAsset.findUniqueOrThrow({ where: { id: done.renderAssetId! } });
    const info = await mediaInfo(await materialize(render.storageKey, "./storage/test/tmp"));
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.fps).toBeCloseTo(30, 0);
    expect(info.videoCodec).toBe("h264");
    expect(info.audioCodec).toBe("aac");
    expect(info.durationSec).toBeGreaterThan(10);

    const report = done.qualityReport as { passed: boolean; checks: { name: string; passed: boolean }[] };
    expect(report.passed).toBe(true);

    // English metadata and provenance.
    expect(done.title).toBe("Why Astronauts Come Home Taller");
    expect(done.hashtags).toContain("#Shorts");
    expect(done.description).toContain("Stock footage:");
    const scenes = await db.videoScene.findMany({ where: { videoId: video.id }, include: { mediaAsset: true } });
    expect(scenes.length).toBeGreaterThan(3);
    expect(scenes.every((s) => s.mediaAsset?.license === "Pexels License" && s.mediaAsset.sourceUrl)).toBe(true);

    // Uploaded once, private, with English defaults.
    expect(youtube.client_.uploads).toHaveLength(1);
    expect(youtube.client_.uploads[0]!.privacyStatus).toBe("private");
    expect(done.youtubeVideoId).toBe("yt_1");
    expect(youtube.client_.thumbnails).toContain("yt_1");

    // Structured logs visible for the UI.
    const logs = await db.systemLog.findMany({ where: { videoId: video.id } });
    expect(logs.some((l) => l.message.startsWith("Video rendered"))).toBe(true);

    // Duplicate protection: publishing again never re-uploads.
    await requestPublish(video.id).catch(() => undefined);
    await waitForStatus(video.id, ["PUBLISHED", "FAILED"]);
    expect(youtube.client_.uploads).toHaveLength(1);

    // Analytics snapshots are collected from the channel.
    const snapshots = await collectAnalyticsForUser(user.id);
    expect(snapshots).toBe(1);
  }, 300_000);

  it("resumes from the failed step without repeating earlier steps", async () => {
    const user = await createTestUser();
    const { video } = await createVideo(user.id, {
      topic: "Why do astronauts grow taller in space?",
      category: "space",
      durationSec: 30,
      templateKey: "minimal",
      autoPublish: false,
    });
    footage.failDownloads = true;
    const failed = await waitForStatus(video.id, ["FAILED", "READY"]);
    expect(failed.status).toBe("FAILED");
    expect(failed.failedStep).toBe("SELECT_FOOTAGE");
    const scriptCalls = ai.calls["script.generate"];
    const ttsCalls = tts.calls;

    footage.failDownloads = false;
    await startOrResume(video.id);
    const ready = await waitForStatus(video.id, ["READY", "FAILED"]);
    expect(ready.status).toBe("READY");
    expect(ai.calls["script.generate"]).toBe(scriptCalls);
    expect(tts.calls).toBe(ttsCalls);

    // Partial regeneration: metadata only - no re-render.
    const renderId = ready.renderAssetId;
    await regenerate(video.id, "GENERATE_METADATA");
    const again = await waitForStatus(video.id, ["READY", "FAILED"]);
    expect(again.status).toBe("READY");
    expect(again.renderAssetId).toBe(renderId);
  }, 300_000);

  it("rejects non-English AI output and never proceeds with it", async () => {
    const user = await createTestUser();
    ai.overrides["script.generate"] = () => ({
      hookStyle: "question",
      sections: [
        { type: "HOOK", text: "Miks astronaudid kosmoses pikemaks kasvavad?" },
        { type: "INFORMATION", text: "Maal surub gravitatsioon selgroo lülivahekettaid kogu päeva kokku." },
        { type: "PAYOFF", text: "Kosmoses see surve kaob ja selgroog venib kuni kolm protsenti." },
      ],
      factsUsed: [],
    });
    ai.overrides["script.revise"] = () => ASTRONAUT_SCRIPT;
    try {
      const { video } = await createVideo(user.id, { topic: "Why do astronauts grow taller in space?", category: "space", durationSec: 30, autoPublish: false });
      const ready = await waitForStatus(video.id, ["READY", "FAILED"]);
      expect(ready.status).toBe("READY");
      const versions = await db.scriptVersion.findMany({ where: { script: { videoId: video.id } }, orderBy: { version: "asc" } });
      expect(versions[0]!.status).toBe("INVALID");
      expect(versions.at(-1)!.status).toBe("VALID");
      expect(versions.at(-1)!.source).toBe("AI_REVISION");
      const voiceovers = await db.voiceover.findMany({ where: { videoId: video.id }, include: { scriptVersion: true } });
      expect(voiceovers.every((v) => v.scriptVersion.status === "VALID")).toBe(true);
    } finally {
      delete ai.overrides["script.generate"];
      delete ai.overrides["script.revise"];
    }
  }, 300_000);

  it("recovers queued work after Redis loses jobs", async () => {
    const user = await createTestUser();
    const { video } = await createVideo(user.id, { topic: "Why do astronauts grow taller in space?", category: "space", durationSec: 30, templateKey: "minimal" }, { start: false });
    // Simulate a step that was recorded as queued but whose Redis job vanished.
    await db.generationJob.create({ data: { videoId: video.id, userId: user.id, step: "RESEARCH_TOPIC", status: "QUEUED", queueName: "pipeline", queueJobId: "missing-job" } });
    await db.video.update({ where: { id: video.id }, data: { status: "RESEARCHING" } });
    const result = await reconcilePipeline();
    expect(result.requeued).toBe(1);
    const ready = await waitForStatus(video.id, ["READY", "FAILED"]);
    expect(ready.error).toBeNull();
    expect(ready.status).toBe("READY");
  }, 300_000);

  it.runIf(localModels)("narrates and subtitles with the free local Kokoro voice and Parakeet recognition", async () => {
    setSpeechProvidersForTesting(new KokoroTTSProvider(), new ParakeetSTTProvider());
    try {
      const user = await createTestUser();
      const voice = await db.voicePreset.findFirstOrThrow({ where: { provider: "kokoro", voiceId: "am_adam" } });
      // The fixed test script is ~68 words; Kokoro reads ~210 wpm, so it fits a 22 s target.
      const { video } = await createVideo(user.id, { topic: "Why do astronauts grow taller in space?", category: "space", durationSec: 22, voicePresetId: voice.id, templateKey: "cinematic", autoPublish: false });
      const ready = await waitForStatus(video.id, ["READY", "FAILED"], 600_000);
      expect(ready.error).toBeNull();
      expect(ready.status).toBe("READY");
      const voiceover = await db.voiceover.findFirstOrThrow({ where: { videoId: video.id, isCurrent: true } });
      expect(voiceover.provider).toBe("kokoro");
      expect(voiceover.durationSec).toBeGreaterThan(15);
      const subtitle = await db.subtitle.findFirstOrThrow({ where: { videoId: video.id, isCurrent: true } });
      expect(subtitle.provider).toBe("parakeet");
      expect(wordErrorRate(fullText(ASTRONAUT_SCRIPT), subtitle.transcript)).toBeLessThan(0.15);
      const report = ready.qualityReport as { passed: boolean };
      expect(report.passed).toBe(true);
      const cost = await db.generationJob.aggregate({ where: { videoId: video.id, step: { in: ["GENERATE_VOICE", "GENERATE_SUBTITLES"] } }, _sum: { costUsd: true } });
      expect(cost._sum.costUsd).toBe(0);
    } finally {
      setSpeechProvidersForTesting(tts, stt);
    }
  }, 700_000);

  it("stores assets through the storage abstraction", async () => {
    const storage = getStorage();
    await storage.upload("tests/hello.txt", Buffer.from("hello"), "text/plain");
    expect(await storage.exists("tests/hello.txt")).toBe(true);
    expect((await storage.download("tests/hello.txt")).toString()).toBe("hello");
    await storage.delete("tests/hello.txt");
    expect(await storage.exists("tests/hello.txt")).toBe(false);
  });
});
