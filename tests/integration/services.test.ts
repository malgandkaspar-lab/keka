import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, disconnectDb } from "@/lib/db";
import { closeRedis, getRedis } from "@/lib/redis";
import { closeQueues } from "@/queues";
import { decryptSecret } from "@/lib/crypto";
import { AuthenticationError, ForbiddenError, LanguageValidationError, LimitExceededError, ValidationError } from "@/lib/errors";
import { authenticate, createSession, registerUser, revokeSession, validateSession } from "@/services/auth/auth-service";
import { getUserSettings, updateUserSettings } from "@/services/settings/settings-service";
import { createVideo } from "@/services/videos/video-service";
import { runDueSchedules, saveSchedule } from "@/services/publishing/scheduler-service";
import { connectAccount, setYouTubeProviderForTesting } from "@/services/youtube/youtube-service";
import { editMetadata, editScript } from "@/services/videos/manual-edits";
import { createManualTopic } from "@/services/topics/topic-service";
import { rateLimit } from "@/lib/rate-limit";
import { createTestUser, resetDatabase } from "../helpers/db";
import { FakeYouTubeProvider } from "../helpers/fakes";

beforeEach(async () => {
  await resetDatabase();
  await getRedis().flushdb();
});

afterAll(async () => {
  await closeQueues();
  await closeRedis();
  await disconnectDb();
});

describe("authentication", () => {
  it("makes the first user an admin and locks registration afterwards", async () => {
    const admin = await registerUser({ email: "Admin@Example.com", password: "long-enough-password" }, false);
    expect(admin.role).toBe("ADMIN");
    expect(admin.email).toBe("admin@example.com");
    await expect(registerUser({ email: "second@example.com", password: "long-enough-password" }, false)).rejects.toBeInstanceOf(ForbiddenError);
    const second = await registerUser({ email: "second@example.com", password: "long-enough-password" }, true);
    expect(second.role).toBe("USER");
    expect(await db.project.count({ where: { userId: second.id, isDefault: true } })).toBe(1);
  });

  it("verifies passwords and manages hashed sessions", async () => {
    const user = await registerUser({ email: "a@example.com", password: "long-enough-password" }, true);
    await expect(authenticate({ email: "a@example.com", password: "wrong-password!!" })).rejects.toBeInstanceOf(AuthenticationError);
    await expect(authenticate({ email: "nobody@example.com", password: "long-enough-password" })).rejects.toBeInstanceOf(AuthenticationError);
    expect((await authenticate({ email: "a@example.com", password: "long-enough-password" })).id).toBe(user.id);

    const session = await createSession(user.id);
    const stored = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(stored.tokenHash).not.toBe(session.token);
    expect((await validateSession(session.token))?.id).toBe(user.id);
    await revokeSession(session.token);
    expect(await validateSession(session.token)).toBeNull();
    expect(await validateSession("garbage")).toBeNull();
  });

  it("rate limits repeated attempts", async () => {
    for (let i = 0; i < 3; i++) await rateLimit("test:ip", 3, 60);
    await expect(rateLimit("test:ip", 3, 60)).rejects.toBeInstanceOf(LimitExceededError);
  });
});

describe("settings and cost control", () => {
  it("validates settings and enforces daily limits", async () => {
    const user = await createTestUser();
    await expect(updateUserSettings(user.id, { musicVolume: 5 })).rejects.toBeInstanceOf(ValidationError);
    await updateUserSettings(user.id, { dailyGenerationLimit: 1, defaultCategory: "space" });
    expect((await getUserSettings(user.id)).defaultCategory).toBe("space");
    await createVideo(user.id, { topic: "Why do astronauts grow taller in space?", category: "space" }, { start: false });
    await expect(createVideo(user.id, { topic: "How do octopuses taste with their arms?", category: "animals" }, { start: false })).rejects.toBeInstanceOf(LimitExceededError);
  });

  it("rejects non-English and disallowed manual topics", async () => {
    const user = await createTestUser();
    await expect(createManualTopic({ userId: user.id, title: "Miks astronaudid kosmoses pikemaks kasvavad", categoryKey: "space", similarityThreshold: 0.55 })).rejects.toBeInstanceOf(LanguageValidationError);
    await expect(createManualTopic({ userId: user.id, title: "How to make a pipe bomb at home", categoryKey: "science", similarityThreshold: 0.55 })).rejects.toThrow(/content policy/);
    const first = await createManualTopic({ userId: user.id, title: "Why do astronauts grow taller in space?", categoryKey: "space", similarityThreshold: 0.55 });
    expect(first.similarTo).toBeNull();
    const dup = await createManualTopic({ userId: user.id, title: "Why astronauts grow taller in space", categoryKey: "space", similarityThreshold: 0.55 });
    expect(dup.similarTo).toBe("Why do astronauts grow taller in space?");
  });
});

describe("automatic mode scheduler", () => {
  it("creates auto-topic videos when a schedule is due", async () => {
    const user = await createTestUser();
    const schedule = await saveSchedule(user.id, {
      name: "Twice a day",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      times: ["09:00", "18:00"],
      timezone: "Europe/Tallinn",
      videosPerRun: 2,
      categories: ["science", "space"],
      durationSec: 30,
      privacy: "PRIVATE",
      autoPublish: true,
    });
    expect(schedule.nextRunAt).not.toBeNull();
    await db.schedule.update({ where: { id: schedule.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    expect(await runDueSchedules()).toBe(1);
    const videos = await db.video.findMany({ where: { scheduleId: schedule.id }, orderBy: { createdAt: "asc" } });
    expect(videos).toHaveLength(2);
    expect(videos.every((v) => v.autoTopic && v.autoPublish)).toBe(true);
    expect(new Set(videos.map((v) => v.category))).toEqual(new Set(["science", "space"]));
    const after = await db.schedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    // A second tick does not run it again.
    expect(await runDueSchedules()).toBe(0);
  });

  it("validates schedule input", async () => {
    const user = await createTestUser();
    await expect(saveSchedule(user.id, { name: "x", daysOfWeek: [], times: ["09:00"], categories: ["science"] })).rejects.toBeInstanceOf(ValidationError);
    await expect(saveSchedule(user.id, { name: "x", daysOfWeek: [1], times: ["25:00"], categories: ["science"] })).rejects.toBeInstanceOf(ValidationError);
    await expect(saveSchedule(user.id, { name: "x", daysOfWeek: [1], times: ["09:00"], categories: ["science"], timezone: "Mars/Olympus" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("YouTube connection", () => {
  it("stores OAuth tokens encrypted", async () => {
    const user = await createTestUser();
    setYouTubeProviderForTesting(new FakeYouTubeProvider());
    try {
      const account = await connectAccount(user.id, "auth-code");
      expect(account.channelTitle).toBe("Fake Channel");
      expect(account.accessTokenEnc).not.toContain("fake-access");
      expect(decryptSecret(account.refreshTokenEnc!)).toBe("fake-refresh");
      expect(account.isDefault).toBe(true);
    } finally {
      setYouTubeProviderForTesting(undefined);
    }
  });
});

describe("manual overrides", () => {
  it("enforces English on edited metadata and scripts", async () => {
    const user = await createTestUser();
    const { video } = await createVideo(user.id, { topic: "Why do astronauts grow taller in space?", category: "space" }, { start: false });
    await expect(
      editMetadata(user.id, video.id, { title: "Warum Astronauten größer werden", description: "Die Schwerkraft drückt die Wirbelsäule zusammen und im All fehlt das völlig.", hashtags: [], tags: [] }),
    ).rejects.toBeInstanceOf(LanguageValidationError);
    await expect(editScript(user.id, video.id, "Kosmoses kasvavad astronaudid pikemaks, sest gravitatsioon ei suru nende selgroogu kokku.")).rejects.toBeInstanceOf(LanguageValidationError);
  });
});
