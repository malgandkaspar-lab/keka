import { z } from "zod";
import type { Schedule } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { LimitExceededError, ValidationError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { logEvent } from "@/services/logging/system-log";
import { createVideo } from "@/services/videos/video-service";

/**
 * SchedulerService - automatic mode.
 *
 * A Schedule describes when to generate (days of week + local times in a timezone),
 * how many videos per run, which categories (rotated), voice, template, duration and
 * publishing behaviour. The maintenance worker calls `runDueSchedules()` every minute;
 * each due schedule creates its videos with AI-selected topics and starts the full
 * pipeline (research -> script -> ... -> upload -> schedule/publish).
 */
const log = createLogger({ module: "scheduler" });

export const scheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1, "Choose at least one day"),
  times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM")).min(1, "Choose at least one time"),
  timezone: z.string().refine(isValidTimeZone, "Unknown time zone").default("UTC"),
  videosPerRun: z.number().int().min(1).max(10).default(1),
  categories: z.array(z.string()).min(1, "Choose at least one category"),
  voicePresetId: z.string().uuid().nullable().optional(),
  templateKey: z.string().optional(),
  durationSec: z.number().int().min(10).max(180).default(30),
  musicMode: z.string().default("auto"),
  privacy: z.enum(["PRIVATE", "UNLISTED", "PUBLIC", "SCHEDULED"]).default("PRIVATE"),
  autoPublish: z.boolean().default(true),
  publishDelayMin: z.number().int().min(0).max(60 * 24 * 14).default(0),
  channelId: z.string().uuid().nullable().optional(),
});
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: weekdays.indexOf(get("weekday")),
  };
}

/** Converts a wall-clock time in `timeZone` to a UTC instant (DST-safe). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (instant: number) => {
    const p = zonedParts(new Date(instant), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - instant;
  };
  let utc = guess - offsetAt(guess);
  utc = guess - offsetAt(utc);
  return new Date(utc);
}

/** Next run strictly after `from`. */
export function computeNextRun(schedule: Pick<Schedule, "daysOfWeek" | "times" | "timezone">, from: Date = new Date()): Date | null {
  if (!schedule.daysOfWeek.length || !schedule.times.length) return null;
  const times = [...schedule.times].sort();
  const start = zonedParts(from, schedule.timezone);
  for (let offset = 0; offset <= 8; offset++) {
    const dayDate = new Date(Date.UTC(start.year, start.month - 1, start.day + offset, 12));
    const weekday = dayDate.getUTCDay();
    if (!schedule.daysOfWeek.includes(weekday)) continue;
    for (const time of times) {
      const [h, m] = time.split(":").map(Number);
      const candidate = zonedTimeToUtc(dayDate.getUTCFullYear(), dayDate.getUTCMonth() + 1, dayDate.getUTCDate(), h!, m!, schedule.timezone);
      if (candidate.getTime() > from.getTime()) return candidate;
    }
  }
  return null;
}

export async function saveSchedule(userId: string, input: unknown, scheduleId?: string): Promise<Schedule> {
  const parsed = scheduleInputSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid schedule", { issues: parsed.error.issues });
  const { templateKey, ...data } = parsed.data;
  const template = templateKey ? await db.generationTemplate.findUnique({ where: { key: templateKey } }) : null;
  if (templateKey && !template) throw new ValidationError(`Unknown template "${templateKey}"`);
  const categories = await db.topicCategory.findMany({ where: { key: { in: data.categories }, enabled: true } });
  if (categories.length !== data.categories.length) throw new ValidationError("One or more categories are unknown or disabled");
  const nextRunAt = data.enabled ? computeNextRun(data) : null;
  const payload = { ...data, templateId: template?.id ?? null, voicePresetId: data.voicePresetId ?? null, channelId: data.channelId ?? null, nextRunAt };
  if (scheduleId) {
    const existing = await db.schedule.findFirst({ where: { id: scheduleId, userId } });
    if (!existing) throw new ValidationError("Schedule not found");
    return db.schedule.update({ where: { id: scheduleId }, data: payload });
  }
  return db.schedule.create({ data: { ...payload, userId } });
}

/** Rotates through the schedule's categories across runs. */
function pickCategory(schedule: Schedule, videosSoFar: number): string {
  return schedule.categories[videosSoFar % schedule.categories.length]!;
}

/** Runs one schedule now: creates its videos and starts their pipelines. */
export async function runSchedule(schedule: Schedule, now = new Date()): Promise<{ created: string[]; skipped?: string }> {
  const created: string[] = [];
  const template = schedule.templateId ? await db.generationTemplate.findUnique({ where: { id: schedule.templateId } }) : null;
  const previous = await db.video.count({ where: { scheduleId: schedule.id } });
  try {
    for (let i = 0; i < schedule.videosPerRun; i++) {
      const publishAt = schedule.privacy === "SCHEDULED" ? new Date(now.getTime() + Math.max(60, schedule.publishDelayMin) * 60_000) : null;
      const { video } = await createVideo(
        schedule.userId,
        {
          autoTopic: true,
          category: pickCategory(schedule, previous + i),
          durationSec: schedule.durationSec,
          voicePresetId: schedule.voicePresetId,
          templateKey: template?.key,
          musicMode: schedule.musicMode,
          privacy: schedule.privacy,
          scheduledPublishAt: publishAt,
          autoPublish: schedule.autoPublish,
          channelId: schedule.channelId,
        },
        { scheduleId: schedule.id },
      );
      created.push(video.id);
    }
    await logEvent({ userId: schedule.userId, message: `Schedule "${schedule.name}" started ${created.length} video(s)`, context: { scheduleId: schedule.id } });
    return { created };
  } catch (error) {
    const reason = error instanceof LimitExceededError ? error.message : `failed: ${(error as Error).message}`;
    await logEvent({ level: "WARN", userId: schedule.userId, message: `Schedule "${schedule.name}" skipped: ${reason}`, context: { scheduleId: schedule.id } });
    return { created, skipped: reason };
  }
}

/** Claims and runs every due schedule. Safe to call concurrently (optimistic claim). */
export async function runDueSchedules(now = new Date()): Promise<number> {
  const due = await db.schedule.findMany({ where: { enabled: true, nextRunAt: { lte: now } } });
  let runs = 0;
  for (const schedule of due) {
    const nextRunAt = computeNextRun(schedule, now);
    const claimed = await db.schedule.updateMany({
      where: { id: schedule.id, nextRunAt: schedule.nextRunAt },
      data: { nextRunAt, lastRunAt: now },
    });
    if (claimed.count === 0) continue; // another worker claimed it
    log.info({ scheduleId: schedule.id }, "running schedule");
    await runSchedule(schedule, now);
    runs++;
  }
  return runs;
}

/** Keeps nextRunAt populated for enabled schedules (e.g. after timezone data changes). */
export async function repairScheduleTimes(): Promise<void> {
  const schedules = await db.schedule.findMany({ where: { enabled: true, nextRunAt: null } });
  for (const schedule of schedules) {
    await db.schedule.update({ where: { id: schedule.id }, data: { nextRunAt: computeNextRun(schedule) } });
  }
}
