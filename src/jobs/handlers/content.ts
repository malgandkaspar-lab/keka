import type { PipelineStep } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { LanguageValidationError, ValidationError } from "@/lib/errors";
import { getAIProvider } from "@/services/ai";
import { performanceHints, preferredHookStyles } from "@/services/analytics/insights";
import { validateBundle } from "@/services/language/language-service";
import { composeDescription, generateMetadata } from "@/services/metadata/metadata-service";
import { loadResearchContext, researchTopic } from "@/services/research/research-service";
import {
  draftFromVersion,
  draftScript,
  fullText,
  programmaticChecks,
  recentHooks,
  saveScriptVersion,
  updateVersionValidation,
  validateDraft,
  currentScriptVersion,
  type ScriptContext,
} from "@/services/scripts/script-service";
import { currentSubtitle } from "@/services/subtitles/subtitle-service";
import { generateTopic, markTopicUsed, recentTopicTitles, rejectTopic } from "@/services/topics/topic-service";
import { loadVideoContext, type VideoContext } from "../context";
import { calibratedWordsPerMinute } from "@/services/tts/speech-rate";
import { resolveVoice } from "@/services/tts/voiceover-service";
import { getTTSProvider } from "@/services/tts";
import type { StepHandler } from "../types";

/** Content steps: topic, research, script, validation, metadata and final English QA. */
const MAX_TOPIC_REROUTES = 2;
const MAX_METADATA_REROUTES = 2;

function stepRunCount(videoId: string, step: PipelineStep): Promise<number> {
  return db.generationJob.count({ where: { videoId, step } });
}

export const generateTopicHandler: StepHandler = async (ctx) => {
  const { video, settings } = await loadVideoContext(ctx.videoId);
  const ai = getAIProvider(settings);
  const rejected = await db.topic.findMany({
    where: { userId: video.userId, status: "REJECTED", createdAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) } },
    select: { title: true },
    take: 50,
  });
  await ctx.progress(20, "Asking the AI for candidate topics");
  const result = await generateTopic({
    userId: video.userId,
    projectId: video.projectId,
    categoryKey: video.category,
    ai,
    minScore: settings.minTopicScore,
    similarityThreshold: settings.topicSimilarityThreshold,
    extraAvoid: rejected.map((r) => r.title),
    performanceHints: await performanceHints(video.userId),
    signal: ctx.signal,
  });
  await db.video.update({ where: { id: video.id }, data: { topicId: result.topic.id } });
  await markTopicUsed(result.topic.id);
  return {
    provider: ai.name,
    costUsd: result.usage.costUsd,
    message: `Topic generated: "${result.topic.title}" (score ${result.topic.overallScore})`,
    output: { topicId: result.topic.id, title: result.topic.title, score: result.topic.overallScore, rejected: result.rejected },
  };
};

export const researchTopicHandler: StepHandler = async (ctx) => {
  const { video, settings } = await loadVideoContext(ctx.videoId);
  if (!video.topic) throw new ValidationError("Video has no topic to research");
  if (!settings.researchEnabled) return { output: { skipped: true }, message: "Research disabled in settings" };
  const ai = getAIProvider(settings);
  await ctx.progress(15, "Searching reliable sources");
  const outcome = await researchTopic({ topic: video.topic, ai, signal: ctx.signal });
  const facts = outcome.extraction.claims.filter((c) => c.type === "ESTABLISHED_FACT").length;
  const output = { status: outcome.status, sources: outcome.sources.length, facts, fromCache: outcome.fromCache };

  if (outcome.status === "INSUFFICIENT") {
    const topicRuns = await stepRunCount(video.id, "GENERATE_TOPIC");
    if (video.autoTopic && topicRuns <= MAX_TOPIC_REROUTES) {
      await rejectTopic(video.topic.id);
      return {
        output,
        costUsd: outcome.usage.costUsd,
        provider: ai.name,
        reroute: { step: "GENERATE_TOPIC", reason: `research could not verify "${video.topic.title}" (${facts} reliable facts)` },
      };
    }
    await ctx.log(`Research found limited reliable information (${facts} facts); the script will avoid unsupported claims`, { level: "WARN" });
  }
  return {
    output,
    costUsd: outcome.usage.costUsd,
    provider: ai.name,
    message: `Research completed: ${outcome.sources.length} sources, ${facts} established facts`,
  };
};

/** Words per minute of the voice that will read this script (learned from past voiceovers). */
async function scriptWordsPerMinute(vc: VideoContext): Promise<number> {
  const { video, settings } = vc;
  try {
    const engine = getTTSProvider(settings).name;
    const voice = await resolveVoice(video.voicePresetId ?? settings.defaultVoicePresetId, engine);
    const speed = (video.voiceSettings as { speed?: number } | null)?.speed ?? (voice.settings as { speed?: number } | null)?.speed ?? 1;
    return await calibratedWordsPerMinute({ provider: engine, voiceId: voice.voiceId, speed, fallbackWpm: settings.wordsPerMinute });
  } catch {
    return settings.wordsPerMinute;
  }
}

async function buildScriptContext(vc: VideoContext): Promise<ScriptContext> {
  const { video, settings, template, categoryName } = vc;
  const research = video.topic ? await loadResearchContext(video.topic.id) : { summary: null, facts: [], uncertain: [], cautions: [], sources: [] };
  return {
    topicTitle: video.topic?.title ?? video.requestedTopic ?? "",
    topicAngle: video.topic?.angle,
    categoryName,
    research,
    targetDurationSec: video.targetDurationSec,
    wordsPerMinute: await scriptWordsPerMinute(vc),
    tolerancePct: settings.durationTolerancePct,
    pacing: template.script.pacing,
    tone: template.script.tone,
    includeCta: video.targetDurationSec >= 30,
    recentHooks: await recentHooks(video.userId),
    preferredHookStyles: await preferredHookStyles(video.userId),
  };
}

export const generateScriptHandler: StepHandler = async (ctx) => {
  const vc = await loadVideoContext(ctx.videoId);
  if (!vc.video.topic) throw new ValidationError("Video has no topic");
  const ai = getAIProvider(vc.settings);
  const scriptCtx = await buildScriptContext(vc);
  await ctx.progress(20, "Writing the first draft");
  const { draft, usage } = await draftScript(ai, scriptCtx, undefined, ctx.signal);
  const version = await saveScriptVersion({
    videoId: vc.video.id,
    draft,
    source: "AI",
    targetDurationSec: vc.video.targetDurationSec,
    wordsPerMinute: scriptCtx.wordsPerMinute,
    aiModel: ai.model,
  });
  return {
    provider: ai.name,
    costUsd: usage.costUsd,
    message: `Script generated (v${version.version}, ${version.wordCount} words, ~${version.estimatedDurationSec.toFixed(1)}s)`,
    output: { scriptVersionId: version.id, version: version.version, words: version.wordCount, estimatedDurationSec: version.estimatedDurationSec },
  };
};

export const validateScriptHandler: StepHandler = async (ctx) => {
  const vc = await loadVideoContext(ctx.videoId);
  const ai = getAIProvider(vc.settings);
  const scriptCtx = await buildScriptContext(vc);
  let version = await currentScriptVersion(ctx.videoId);
  let cost = 0;

  if (version.source === "MANUAL") {
    // A human-edited script is never silently rewritten: enforce hard rules only.
    const validation = programmaticChecks(draftFromVersion(version), scriptCtx);
    const blocking = validation.issues.filter((i) => i.severity === "error" && ["english", "policy", "formatting"].includes(i.check));
    for (const issue of validation.issues) if (!blocking.includes(issue)) issue.severity = "warning";
    await updateVersionValidation(version.id, { ...validation, passed: blocking.length === 0 });
    if (blocking.length) {
      if (blocking.some((i) => i.check === "english")) throw new LanguageValidationError("script", blocking.map((i) => i.message));
      throw new ValidationError(`Edited script failed validation: ${blocking.map((i) => i.message).join("; ")}`);
    }
    return { message: "Edited script validated", output: { scriptVersionId: version.id, warnings: validation.issues.length } };
  }

  for (let attempt = 1; attempt <= vc.settings.maxScriptAttempts; attempt++) {
    await ctx.progress(Math.min(90, attempt * 30), `Quality control pass ${attempt}`);
    const draft = draftFromVersion(version);
    const { validation, usage } = await validateDraft(ai, draft, scriptCtx, ctx.signal);
    cost += usage?.costUsd ?? 0;
    await updateVersionValidation(version.id, validation);
    if (validation.passed) {
      return {
        provider: ai.name,
        costUsd: cost,
        message: `Script validation passed (v${version.version}, ~${validation.metrics.estimatedDurationSec.toFixed(1)}s)`,
        output: { scriptVersionId: version.id, attempts: attempt, metrics: validation.metrics },
      };
    }
    const problems = validation.issues.filter((i) => i.severity === "error").map((i) => i.message);
    await ctx.log(`Script v${version.version} failed QC: ${problems.join("; ")}`, { level: "WARN" });
    if (attempt === vc.settings.maxScriptAttempts) break;
    const revision = await draftScript(ai, scriptCtx, { previous: fullText(draft), issues: problems }, ctx.signal);
    cost += revision.usage.costUsd;
    version = await saveScriptVersion({
      videoId: ctx.videoId,
      draft: revision.draft,
      source: "AI_REVISION",
      targetDurationSec: vc.video.targetDurationSec,
      wordsPerMinute: scriptCtx.wordsPerMinute,
      aiModel: ai.model,
    });
  }
  const last = await currentScriptVersion(ctx.videoId);
  const issues = ((last.validation as { issues?: { message: string; severity: string }[] } | null)?.issues ?? [])
    .filter((i) => i.severity === "error")
    .map((i) => i.message);
  if (issues.some((i) => /not English/i.test(i))) throw new LanguageValidationError("script", issues, false);
  throw new ValidationError(`Script failed quality control after ${vc.settings.maxScriptAttempts} attempts: ${issues.join("; ")}`);
};

export const generateMetadataHandler: StepHandler = async (ctx) => {
  const vc = await loadVideoContext(ctx.videoId);
  const { video, settings } = vc;
  if (video.metadataLocked && video.title && video.description) {
    return { message: "Metadata was edited manually; keeping it", output: { locked: true } };
  }
  const ai = getAIProvider(settings);
  const version = await currentScriptVersion(video.id);
  const recentTitles = (await recentTopicTitles(video.userId, 60)).filter((t) => t !== video.title && t !== video.topic?.title);
  const { metadata, usage, attempts } = await generateMetadata(
    ai,
    { topicTitle: video.topic?.title ?? "", script: version.fullText, categoryName: vc.categoryName, sources: [], recentTitles },
    { signal: ctx.signal },
  );
  const scenes = await db.videoScene.findMany({ where: { videoId: video.id }, include: { mediaAsset: true }, orderBy: { index: "asc" } });
  const authors = [...new Set(scenes.map((s) => s.mediaAsset?.author).filter((a): a is string => Boolean(a)))];
  const credits = authors.length ? [`Stock footage: ${authors.slice(0, 8).join(", ")} (Pexels)`] : [];
  await db.video.update({
    where: { id: video.id },
    data: {
      title: metadata.title,
      description: composeDescription(metadata, { credits, appendHashtags: settings.appendHashtagsToDescription }),
      hashtags: metadata.hashtags,
      tags: metadata.tags,
      thumbnailText: metadata.thumbnailText,
    },
  });
  return { provider: ai.name, costUsd: usage.costUsd, message: `Metadata generated: "${metadata.title}"`, output: { ...metadata, attempts } };
};

export const contentQaHandler: StepHandler = async (ctx) => {
  const vc = await loadVideoContext(ctx.videoId);
  const { video } = vc;
  const version = await currentScriptVersion(video.id);
  const subtitle = await currentSubtitle(video.id);
  const subtitleText = subtitle ? ((subtitle.cues as { lines: string[][] }[]) ?? []).map((c) => c.lines.map((l) => l.join(" ")).join(" ")).join(" ") : null;
  // Credits lines contain author names; validate the human-written part of the description.
  const description = (video.description ?? "").split(/\n\nCredits:/)[0] ?? "";
  const report = validateBundle({
    topic: video.topic?.title,
    research: video.topic?.researchSummary,
    script: version.fullText,
    title: video.title,
    description,
    hashtags: video.hashtags,
    tags: video.tags,
    subtitles: subtitleText,
    thumbnail: video.thumbnailText,
  });
  await db.video.update({ where: { id: video.id }, data: { contentQaReport: JSON.parse(JSON.stringify(report)) } });
  if (!video.title || !video.description) throw new ValidationError("Video has no title/description");
  if (report.passed) return { message: "Final English QA passed", output: { fields: Object.keys(report.fields) } };

  const failed = report.failedFields;
  await ctx.log(`Final English QA failed for: ${failed.join(", ")}`, { level: "WARN" });
  const metadataFields = ["title", "description", "hashtags", "tags", "thumbnail"];
  if (failed.every((f) => metadataFields.includes(f)) && !video.metadataLocked) {
    const runs = await stepRunCount(video.id, "GENERATE_METADATA");
    if (runs <= MAX_METADATA_REROUTES) return { reroute: { step: "GENERATE_METADATA", reason: `non-English ${failed.join(", ")}` }, output: { failed } };
  }
  if (failed.includes("subtitles") && !failed.includes("script")) {
    const runs = await stepRunCount(video.id, "GENERATE_SUBTITLES");
    if (runs <= 2) return { reroute: { step: "GENERATE_SUBTITLES", reason: "non-English subtitles" }, output: { failed } };
  }
  if (failed.includes("script") && version.source !== "MANUAL") {
    const runs = await stepRunCount(video.id, "GENERATE_SCRIPT");
    if (runs <= 2) return { reroute: { step: "GENERATE_SCRIPT", reason: "non-English script" }, output: { failed } };
  }
  const reasons = failed.map((f) => `${f}: ${report.fields[f]?.reasons.join("; ")}`);
  throw new LanguageValidationError("content", reasons, false);
};

