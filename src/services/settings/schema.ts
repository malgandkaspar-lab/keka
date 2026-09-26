import { z } from "zod";

/**
 * User-level settings. Stored as one AppSetting row per key; missing keys fall back to
 * the defaults declared here, so adding a new setting never requires a migration.
 */
export const userSettingsSchema = z.object({
  defaultCategory: z.string().default("science"),
  defaultDurationSec: z.number().int().min(10).max(180).default(30),
  durationPresets: z.array(z.number().int().min(10).max(180)).default([15, 30, 45, 60]),
  defaultVoicePresetId: z.string().uuid().nullable().default(null),
  defaultTemplateKey: z.string().default("fast_viral"),
  defaultMusicMode: z.string().default("auto"),
  subtitleStyleKey: z.string().nullable().default(null),

  defaultPrivacy: z.enum(["PRIVATE", "UNLISTED", "PUBLIC", "SCHEDULED"]).default("PRIVATE"),
  autoPublish: z.boolean().default(false),
  youtubeCategoryId: z.string().default("27"),
  appendHashtagsToDescription: z.boolean().default(true),

  dailyGenerationLimit: z.number().int().min(0).max(1000).default(10),
  monthlyGenerationLimit: z.number().int().min(0).max(10000).default(200),
  monthlyBudgetUsd: z.number().min(0).max(100000).default(100),

  aiProvider: z.enum(["anthropic"]).default("anthropic"),
  aiModel: z.string().default("claude-opus-5"),
  aiEffort: z.enum(["low", "medium", "high"]).default("medium"),

  ttsProvider: z.enum(["elevenlabs"]).default("elevenlabs"),
  ttsModelId: z.string().default("eleven_multilingual_v2"),
  sttProvider: z.enum(["elevenlabs", "openai"]).default("elevenlabs"),
  wordsPerMinute: z.number().int().min(100).max(240).default(165),
  durationTolerancePct: z.number().min(0.03).max(0.4).default(0.12),

  researchEnabled: z.boolean().default(true),
  minTopicScore: z.number().min(0).max(10).default(6.5),
  topicSimilarityThreshold: z.number().min(0.2).max(0.95).default(0.55),
  maxScriptAttempts: z.number().int().min(1).max(6).default(3),

  musicVolume: z.number().min(0.03).max(0.25).default(0.12),
  sfxEnabled: z.boolean().default(true),
  imageFallbackEnabled: z.boolean().default(true),
});

export type UserSettings = z.infer<typeof userSettingsSchema>;
export type UserSettingKey = keyof UserSettings;

export const DEFAULT_SETTINGS: UserSettings = userSettingsSchema.parse({});

/** Partial update payload accepted by the settings API. */
export const userSettingsUpdateSchema = userSettingsSchema.partial();
