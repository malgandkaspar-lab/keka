import type { Prisma } from "@/generated/prisma/client";
import { SUBTITLE_STYLE_PRESETS, subtitleStyleSchema, type SubtitleStyle } from "@/config/templates";
import { db } from "@/lib/db";
import { ConflictError, ValidationError } from "@/lib/errors";

/**
 * Custom subtitle styles (per user), stored as AppSetting rows `subtitleStyle:<key>`.
 * Built-in presets (fast_viral, cinematic, minimal) cannot be overwritten.
 */
const PREFIX = "subtitleStyle:";
export const SUBTITLE_FONTS = ["DejaVu Sans", "DejaVu Serif", "DejaVu Sans Mono", "Liberation Sans", "Liberation Serif"];

export async function listCustomSubtitleStyles(userId: string): Promise<SubtitleStyle[]> {
  const rows = await db.appSetting.findMany({ where: { userId, key: { startsWith: PREFIX } }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => subtitleStyleSchema.safeParse(r.value)).filter((p) => p.success).map((p) => p.data!);
}

export async function saveCustomSubtitleStyle(userId: string, input: unknown): Promise<SubtitleStyle> {
  const parsed = subtitleStyleSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid subtitle style", { issues: parsed.error.issues });
  const key = parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (!key) throw new ValidationError("Give the style a name");
  if (SUBTITLE_STYLE_PRESETS[key]) throw new ConflictError("Built-in styles cannot be replaced; choose another name");
  if (!SUBTITLE_FONTS.includes(parsed.data.font)) throw new ValidationError(`Font must be one of: ${SUBTITLE_FONTS.join(", ")}`);
  const style = { ...parsed.data, key };
  await db.appSetting.upsert({
    where: { userId_key: { userId, key: `${PREFIX}${key}` } },
    create: { userId, key: `${PREFIX}${key}`, value: style as unknown as Prisma.InputJsonValue },
    update: { value: style as unknown as Prisma.InputJsonValue },
  });
  return style;
}

export async function deleteCustomSubtitleStyle(userId: string, key: string): Promise<void> {
  await db.appSetting.deleteMany({ where: { userId, key: `${PREFIX}${key}` } });
}
