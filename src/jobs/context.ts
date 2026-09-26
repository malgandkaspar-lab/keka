import type { Prisma } from "@/generated/prisma/client";
import { BUILT_IN_TEMPLATES, SUBTITLE_STYLE_PRESETS, templateConfigSchema, type SubtitleStyle, type TemplateConfig } from "@/config/templates";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { getUserSettings } from "@/services/settings/settings-service";
import type { UserSettings } from "@/services/settings/schema";

/**
 * Loads everything a pipeline step needs about a video: the row with its topic and
 * template, the owner's settings, and the resolved (validated) template configuration.
 */
const videoInclude = {
  topic: true,
  template: true,
  project: true,
} satisfies Prisma.VideoInclude;

export type VideoWithRelations = Prisma.VideoGetPayload<{ include: typeof videoInclude }>;

export interface VideoContext {
  video: VideoWithRelations;
  settings: UserSettings;
  template: TemplateConfig;
  templateKey: string;
  subtitleStyle: SubtitleStyle;
  categoryName: string;
}

export function resolveTemplateConfig(raw: unknown, key: string | undefined): TemplateConfig {
  const parsed = templateConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const builtIn = BUILT_IN_TEMPLATES.find((t) => t.key === key) ?? BUILT_IN_TEMPLATES[0]!;
  return builtIn.config;
}

export async function resolveSubtitleStyle(settings: UserSettings, template: TemplateConfig, userId: string): Promise<SubtitleStyle> {
  const key = settings.subtitleStyleKey;
  if (!key) return template.subtitles;
  if (SUBTITLE_STYLE_PRESETS[key]) return SUBTITLE_STYLE_PRESETS[key]!;
  const custom = await db.appSetting.findUnique({ where: { userId_key: { userId, key: `subtitleStyle:${key}` } } });
  if (custom) {
    const parsed = templateConfigSchema.shape.subtitles.safeParse(custom.value);
    if (parsed.success) return parsed.data;
  }
  return template.subtitles;
}

export async function loadVideoContext(videoId: string): Promise<VideoContext> {
  const video = await db.video.findUnique({ where: { id: videoId }, include: videoInclude });
  if (!video) throw new NotFoundError("Video", videoId);
  const settings = await getUserSettings(video.userId);
  const templateKey = video.template?.key ?? settings.defaultTemplateKey;
  const template = resolveTemplateConfig(video.template?.config, templateKey);
  const subtitleStyle = await resolveSubtitleStyle(settings, template, video.userId);
  const category = await db.topicCategory.findUnique({ where: { key: video.category } });
  return { video, settings, template, templateKey, subtitleStyle, categoryName: category?.name ?? video.category };
}
