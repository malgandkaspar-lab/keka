import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { DEFAULT_SETTINGS, userSettingsSchema, userSettingsUpdateSchema, type UserSettings } from "./schema";

/**
 * SettingsService
 *
 * Purpose: read and write per-user configuration (defaults, limits, providers).
 * Inputs: userId, partial settings objects.
 * Outputs: a complete, validated UserSettings object (defaults merged in).
 * Errors: ValidationError for invalid values.
 */
export async function getUserSettings(userId: string): Promise<UserSettings> {
  const rows = await db.appSetting.findMany({ where: { userId } });
  const stored: Record<string, unknown> = {};
  for (const row of rows) stored[row.key] = row.value;
  const parsed = userSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...stored });
  if (parsed.success) return parsed.data;
  // A stored value became invalid (e.g. schema tightened) - fall back per key.
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const [key, value] of Object.entries(stored)) {
    const single = userSettingsSchema.partial().safeParse({ [key]: value });
    if (single.success) Object.assign(merged, single.data);
  }
  return userSettingsSchema.parse(merged);
}

function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

export async function updateUserSettings(userId: string, update: unknown): Promise<UserSettings> {
  const parsed = userSettingsUpdateSchema.safeParse(update);
  if (!parsed.success) {
    throw new ValidationError("Invalid settings", { issues: parsed.error.issues });
  }
  const entries = Object.entries(parsed.data).filter(([, v]) => v !== undefined);
  await db.$transaction(
    entries.map(([key, value]) =>
      db.appSetting.upsert({
        where: { userId_key: { userId, key } },
        create: { userId, key, value: toJson(value) },
        update: { value: toJson(value) },
      }),
    ),
  );
  return getUserSettings(userId);
}
