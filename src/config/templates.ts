import { z } from "zod";

/**
 * Template + subtitle style schemas.
 *
 * Templates (GenerationTemplate.config in the database) describe how a video looks
 * and sounds. Built-in templates are seeded from BUILT_IN_TEMPLATES; users can add
 * their own templates with any config that satisfies `templateConfigSchema`.
 */
export const subtitleStyleSchema = z.object({
  key: z.string(),
  name: z.string(),
  font: z.string().default("DejaVu Sans"),
  fontSize: z.number().int().min(24).max(200).default(96),
  bold: z.boolean().default(true),
  uppercase: z.boolean().default(true),
  position: z.enum(["upper", "center", "lower"]).default("center"),
  marginV: z.number().int().min(0).max(900).default(420),
  maxWordsPerLine: z.number().int().min(1).max(8).default(3),
  maxLines: z.number().int().min(1).max(3).default(2),
  maxCueDurationSec: z.number().min(0.5).max(6).default(1.8),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#FFFFFF"),
  highlightColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#FFD400"),
  outlineColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#000000"),
  outlineWidth: z.number().min(0).max(20).default(7),
  shadow: z.number().min(0).max(10).default(3),
  animation: z.enum(["pop", "fade", "none"]).default("pop"),
  emphasis: z.enum(["highlight-word", "none"]).default("highlight-word"),
  timingOffsetSec: z.number().min(-1).max(1).default(0),
});
export type SubtitleStyle = z.infer<typeof subtitleStyleSchema>;

export const videoStyleSchema = z.object({
  targetShotSec: z.number().min(1).max(10),
  minShotSec: z.number().min(0.8).max(10),
  maxShotSec: z.number().min(1).max(15),
  transition: z.enum(["cut", "fade", "slideleft", "slideup", "smoothleft", "circleopen", "dissolve"]),
  transitionDurationSec: z.number().min(0).max(1.5),
  zoomAmount: z.number().min(0).max(0.3),
  panEnabled: z.boolean(),
  colorGrade: z.enum(["none", "vivid", "cinematic", "clean"]),
  vignette: z.boolean(),
});
export type VideoStyle = z.infer<typeof videoStyleSchema>;

export const audioStyleSchema = z.object({
  musicVolume: z.number().min(0).max(0.3),
  duckingEnabled: z.boolean(),
  sfxTransitions: z.boolean(),
  sfxIntroImpact: z.boolean(),
  sfxVolume: z.number().min(0).max(1),
  preferredMoods: z.array(z.string()).default([]),
});
export type AudioStyle = z.infer<typeof audioStyleSchema>;

export const templateConfigSchema = z.object({
  video: videoStyleSchema,
  subtitles: subtitleStyleSchema,
  audio: audioStyleSchema,
  script: z.object({
    pacing: z.enum(["fast", "measured", "calm"]),
    tone: z.string(),
  }),
});
export type TemplateConfig = z.infer<typeof templateConfigSchema>;

export const SUBTITLE_STYLE_PRESETS: Record<string, SubtitleStyle> = {
  fast_viral: subtitleStyleSchema.parse({
    key: "fast_viral",
    name: "Fast Viral",
    font: "DejaVu Sans",
    fontSize: 100,
    uppercase: true,
    position: "center",
    marginV: 520,
    maxWordsPerLine: 3,
    maxLines: 1,
    maxCueDurationSec: 1.4,
    highlightColor: "#FFD400",
    outlineWidth: 8,
    animation: "pop",
    emphasis: "highlight-word",
  }),
  cinematic: subtitleStyleSchema.parse({
    key: "cinematic",
    name: "Cinematic",
    font: "DejaVu Serif",
    fontSize: 78,
    uppercase: false,
    bold: true,
    position: "lower",
    marginV: 380,
    maxWordsPerLine: 4,
    maxLines: 2,
    maxCueDurationSec: 2.4,
    highlightColor: "#F5D08A",
    outlineWidth: 3,
    shadow: 4,
    animation: "fade",
    emphasis: "highlight-word",
  }),
  minimal: subtitleStyleSchema.parse({
    key: "minimal",
    name: "Minimal",
    font: "DejaVu Sans",
    fontSize: 72,
    uppercase: false,
    bold: true,
    position: "lower",
    marginV: 420,
    maxWordsPerLine: 4,
    maxLines: 2,
    maxCueDurationSec: 2.2,
    highlightColor: "#FFFFFF",
    outlineWidth: 4,
    shadow: 1,
    animation: "none",
    emphasis: "none",
  }),
};

export interface BuiltInTemplate {
  key: string;
  name: string;
  description: string;
  config: TemplateConfig;
}

export const BUILT_IN_TEMPLATES: BuiltInTemplate[] = [
  {
    key: "fast_viral",
    name: "Fast Viral",
    description: "Fast cuts, punchy word-by-word subtitles, frequent visual changes and subtle zooms.",
    config: {
      video: {
        targetShotSec: 2.2,
        minShotSec: 1.2,
        maxShotSec: 3.5,
        transition: "slideleft",
        transitionDurationSec: 0.25,
        zoomAmount: 0.12,
        panEnabled: true,
        colorGrade: "vivid",
        vignette: false,
      },
      subtitles: SUBTITLE_STYLE_PRESETS.fast_viral!,
      audio: {
        musicVolume: 0.13,
        duckingEnabled: true,
        sfxTransitions: true,
        sfxIntroImpact: true,
        sfxVolume: 0.35,
        preferredMoods: ["energetic", "technological"],
      },
      script: { pacing: "fast", tone: "energetic, punchy and curious" },
    },
  },
  {
    key: "cinematic",
    name: "Cinematic",
    description: "Slower cuts, atmospheric footage and music, elegant subtitles.",
    config: {
      video: {
        targetShotSec: 4,
        minShotSec: 2.5,
        maxShotSec: 6,
        transition: "fade",
        transitionDurationSec: 0.6,
        zoomAmount: 0.07,
        panEnabled: true,
        colorGrade: "cinematic",
        vignette: true,
      },
      subtitles: SUBTITLE_STYLE_PRESETS.cinematic!,
      audio: {
        musicVolume: 0.14,
        duckingEnabled: true,
        sfxTransitions: false,
        sfxIntroImpact: true,
        sfxVolume: 0.25,
        preferredMoods: ["cinematic", "mysterious", "inspiring"],
      },
      script: { pacing: "measured", tone: "awe-inspiring, documentary-style storytelling" },
    },
  },
  {
    key: "minimal",
    name: "Minimal",
    description: "Clean visuals, simple subtitles and very few effects.",
    config: {
      video: {
        targetShotSec: 3.2,
        minShotSec: 2,
        maxShotSec: 5,
        transition: "cut",
        transitionDurationSec: 0,
        zoomAmount: 0.04,
        panEnabled: false,
        colorGrade: "clean",
        vignette: false,
      },
      subtitles: SUBTITLE_STYLE_PRESETS.minimal!,
      audio: {
        musicVolume: 0.1,
        duckingEnabled: true,
        sfxTransitions: false,
        sfxIntroImpact: false,
        sfxVolume: 0.2,
        preferredMoods: ["documentary", "calm"],
      },
      script: { pacing: "calm", tone: "clear, calm and conversational" },
    },
  },
];
