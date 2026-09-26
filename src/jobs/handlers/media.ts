import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { MissingCredentialError, ValidationError } from "@/lib/errors";
import { getAIProvider } from "@/services/ai";
import { getVideoProvider } from "@/services/footage";
import { searchSceneFootage, selectFootageForVideo } from "@/services/footage/footage-service";
import { planVisuals, segmentNarration, wordsOrEstimate } from "@/services/footage/scene-planner";
import { selectMusic } from "@/services/music/music-service";
import { currentScriptVersion } from "@/services/scripts/script-service";
import { generateSubtitles } from "@/services/subtitles/subtitle-service";
import { getSTTProvider, getTTSProvider } from "@/services/tts";
import type { VoiceSettings } from "@/services/tts/types";
import { currentVoiceover, generateVoiceover, resolveVoice, voiceoverWords } from "@/services/tts/voiceover-service";
import { loadVideoContext } from "../context";
import type { StepHandler } from "../types";

/** Media steps: voiceover, visual plan, footage, subtitles and music. */

export const generateVoiceHandler: StepHandler = async (ctx) => {
  const { video, settings } = await loadVideoContext(ctx.videoId);
  const version = await currentScriptVersion(video.id);
  if (version.status !== "VALID") throw new ValidationError("The current script has not passed validation");
  const voice = await resolveVoice(video.voicePresetId ?? settings.defaultVoicePresetId);
  const provider = getTTSProvider(settings);
  const voiceSettings: VoiceSettings = {
    ...((voice.settings ?? {}) as VoiceSettings),
    ...((video.voiceSettings ?? {}) as VoiceSettings),
  };
  await ctx.progress(20, `Synthesising English narration with ${voice.name}`);
  const result = await generateVoiceover({
    videoId: video.id,
    userId: video.userId,
    scriptVersion: version,
    voice,
    modelId: settings.ttsModelId,
    settings: voiceSettings,
    targetDurationSec: video.targetDurationSec,
    provider,
    signal: ctx.signal,
  });
  return {
    provider: provider.name,
    costUsd: result.costUsd,
    message: `Voice generated (${voice.name}, ${result.voiceover.durationSec.toFixed(1)}s${result.reused ? ", reused from cache" : ""})`,
    output: { voiceoverId: result.voiceover.id, durationSec: result.voiceover.durationSec, reused: result.reused, words: result.words.length },
  };
};

export const planVisualsHandler: StepHandler = async (ctx) => {
  const { video, settings, template } = await loadVideoContext(ctx.videoId);
  const voiceover = await currentVoiceover(video.id);
  const version = await currentScriptVersion(video.id);
  const words = wordsOrEstimate(voiceoverWords(voiceover), version.fullText, voiceover.durationSec);
  const segments = segmentNarration(words, voiceover.durationSec, template.video);
  if (segments.length === 0) throw new ValidationError("Narration could not be split into scenes");
  const ai = getAIProvider(settings);
  const plan = await planVisuals({
    ai,
    topic: video.topic?.title ?? "",
    segments,
    defaultTransition: template.video.transition,
    preferredMoods: template.audio.preferredMoods,
    signal: ctx.signal,
  });
  await db.$transaction([
    db.videoScene.deleteMany({ where: { videoId: video.id } }),
    db.videoScene.createMany({
      data: plan.scenes.map((scene) => ({
        videoId: video.id,
        index: scene.index,
        startSec: scene.start,
        endSec: scene.end,
        narration: scene.text,
        visualDescription: scene.visualDescription,
        keywords: scene.keywords,
        fallbackKeywords: scene.fallbackKeywords,
        transition: template.video.transition === "cut" ? "cut" : scene.transition,
      })),
    }),
    db.video.update({ where: { id: video.id }, data: { musicMood: video.musicMode === "auto" ? plan.musicMood : video.musicMood } }),
  ]);
  return {
    provider: ai.name,
    costUsd: plan.usage.costUsd,
    message: `Visual plan created: ${plan.scenes.length} scenes, ${plan.musicMood} mood`,
    output: { scenes: plan.scenes.length, musicMood: plan.musicMood },
  };
};

export const searchFootageHandler: StepHandler = async (ctx) => {
  const { video, settings, categoryName } = await loadVideoContext(ctx.videoId);
  const provider = getVideoProvider();
  const scenes = await db.videoScene.findMany({ where: { videoId: video.id }, orderBy: { index: "asc" } });
  const topicWords = (video.topic?.title ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 4);
  const videoFallback = [...new Set([topicWords.slice(0, 2).join(" "), categoryName.toLowerCase()])].filter(Boolean);
  let totalCandidates = 0;
  for (const [i, scene] of scenes.entries()) {
    if (scene.locked && scene.mediaAssetId) continue;
    const result = await searchSceneFootage({
      provider,
      keywords: scene.keywords,
      fallbackKeywords: scene.fallbackKeywords,
      videoFallbackKeywords: videoFallback,
      allowImages: settings.imageFallbackEnabled,
      signal: ctx.signal,
    });
    totalCandidates += result.candidates.length;
    await db.videoScene.update({
      where: { id: scene.id },
      data: {
        candidates: result.candidates as unknown as Prisma.InputJsonValue,
        searchLog: result.searchLog as unknown as Prisma.InputJsonValue,
      },
    });
    await ctx.progress(Math.round(((i + 1) / scenes.length) * 100), `Scene ${i + 1}/${scenes.length}: ${result.candidates.length} candidates`);
  }
  return { provider: provider.name, message: `Footage found: ${totalCandidates} candidates for ${scenes.length} scenes`, output: { totalCandidates } };
};

export const selectFootageHandler: StepHandler = async (ctx) => {
  const provider = getVideoProvider();
  const result = await selectFootageForVideo({
    provider,
    videoId: ctx.videoId,
    userId: ctx.userId,
    signal: ctx.signal,
    onProgress: (done, total) => void ctx.progress(Math.round((done / total) * 100), `Downloaded ${done}/${total}`),
  });
  if (result.reused > 0) await ctx.log(`${result.reused} scene(s) reuse footage from other scenes (no unique match found)`, { level: "WARN" });
  return { provider: provider.name, message: `Footage selected for ${result.selected + result.reused} scenes`, output: result };
};

export const generateSubtitlesHandler: StepHandler = async (ctx) => {
  const { video, settings, subtitleStyle } = await loadVideoContext(ctx.videoId);
  const voiceover = await currentVoiceover(video.id);
  const version = await currentScriptVersion(video.id);
  let stt = null;
  try {
    stt = getSTTProvider(settings);
  } catch (error) {
    if (!(error instanceof MissingCredentialError)) throw error;
    await ctx.log(`${error.message} Falling back to TTS timestamps.`, { level: "WARN" });
  }
  await ctx.progress(20, "Transcribing the final voiceover (English)");
  const result = await generateSubtitles({
    videoId: video.id,
    userId: video.userId,
    scriptText: version.fullText,
    voiceoverKey: voiceover.asset.storageKey,
    voiceoverDurationSec: voiceover.durationSec,
    ttsWords: voiceoverWords(voiceover),
    style: subtitleStyle,
    stt,
    signal: ctx.signal,
  });
  const cues = (result.subtitle.cues as unknown[]).length;
  return {
    provider: result.provider,
    costUsd: result.costUsd,
    message: `Subtitles generated: ${cues} cues (${result.provider}${result.wer !== null ? `, WER ${(result.wer * 100).toFixed(0)}%` : ""})`,
    output: { subtitleId: result.subtitle.id, cues, wer: result.wer },
  };
};

export const selectMusicHandler: StepHandler = async (ctx) => {
  const { video, template } = await loadVideoContext(ctx.videoId);
  if (video.musicMode === "manual" && video.musicTrackId) {
    return { message: "Using manually selected music", output: { trackId: video.musicTrackId } };
  }
  const voiceover = await currentVoiceover(video.id);
  const { track, mood, provider } = await selectMusic({
    userId: video.userId,
    mode: video.musicMode,
    plannedMood: video.musicMood,
    preferredMoods: template.audio.preferredMoods,
    durationSec: voiceover.durationSec + 1,
  });
  await db.video.update({ where: { id: video.id }, data: { musicTrackId: track?.id ?? null, musicMood: mood } });
  return {
    provider: provider ?? undefined,
    message: track ? `Music selected: ${track.title} (${mood})` : "No music (disabled)",
    output: { trackId: track?.id ?? null, mood },
  };
};
