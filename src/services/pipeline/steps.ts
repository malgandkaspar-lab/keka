import type { PipelineStep, VideoStatus } from "@/generated/prisma/enums";

/**
 * Pipeline step definitions: order, queue, lifecycle status, timeout, retries and the
 * progress label shown in the UI. Steps are persisted individually (GenerationJob), so
 * a failure at any step resumes from that step without repeating earlier work.
 */
export type QueueName = "pipeline" | "render" | "publish" | "maintenance";

export interface StepDefinition {
  step: PipelineStep;
  jobName: string;
  queue: QueueName;
  status: VideoStatus;
  label: string;
  doneMessage: string;
  timeoutMs: number;
  attempts: number;
}

const MIN = 60_000;

export const STEP_DEFINITIONS: Record<PipelineStep, StepDefinition> = {
  GENERATE_TOPIC: { step: "GENERATE_TOPIC", jobName: "generate-topic", queue: "pipeline", status: "TOPIC_GENERATING", label: "Generating topic...", doneMessage: "Topic generated", timeoutMs: 5 * MIN, attempts: 3 },
  RESEARCH_TOPIC: { step: "RESEARCH_TOPIC", jobName: "research-topic", queue: "pipeline", status: "RESEARCHING", label: "Researching...", doneMessage: "Research completed", timeoutMs: 10 * MIN, attempts: 3 },
  GENERATE_SCRIPT: { step: "GENERATE_SCRIPT", jobName: "generate-script", queue: "pipeline", status: "SCRIPT_GENERATING", label: "Writing script...", doneMessage: "Script generated", timeoutMs: 8 * MIN, attempts: 3 },
  VALIDATE_SCRIPT: { step: "VALIDATE_SCRIPT", jobName: "validate-script", queue: "pipeline", status: "SCRIPT_REVIEW", label: "Validating script...", doneMessage: "Script validation passed", timeoutMs: 20 * MIN, attempts: 3 },
  GENERATE_VOICE: { step: "GENERATE_VOICE", jobName: "generate-voice", queue: "pipeline", status: "VOICE_GENERATING", label: "Generating voice...", doneMessage: "Voice generated", timeoutMs: 8 * MIN, attempts: 3 },
  PLAN_VISUALS: { step: "PLAN_VISUALS", jobName: "plan-visuals", queue: "pipeline", status: "MEDIA_SEARCHING", label: "Planning visuals...", doneMessage: "Visual plan created", timeoutMs: 5 * MIN, attempts: 3 },
  SEARCH_FOOTAGE: { step: "SEARCH_FOOTAGE", jobName: "search-footage", queue: "pipeline", status: "MEDIA_SEARCHING", label: "Finding footage...", doneMessage: "Footage found", timeoutMs: 10 * MIN, attempts: 3 },
  SELECT_FOOTAGE: { step: "SELECT_FOOTAGE", jobName: "select-footage", queue: "pipeline", status: "MEDIA_SEARCHING", label: "Downloading footage...", doneMessage: "Footage selected", timeoutMs: 20 * MIN, attempts: 3 },
  GENERATE_SUBTITLES: { step: "GENERATE_SUBTITLES", jobName: "generate-subtitles", queue: "pipeline", status: "SUBTITLES_GENERATING", label: "Generating subtitles...", doneMessage: "Subtitles generated", timeoutMs: 8 * MIN, attempts: 3 },
  SELECT_MUSIC: { step: "SELECT_MUSIC", jobName: "select-music", queue: "pipeline", status: "EDITING", label: "Choosing music...", doneMessage: "Music selected", timeoutMs: 5 * MIN, attempts: 3 },
  RENDER_VIDEO: { step: "RENDER_VIDEO", jobName: "render-video", queue: "render", status: "RENDERING", label: "Rendering...", doneMessage: "Video rendered", timeoutMs: 45 * MIN, attempts: 3 },
  QUALITY_CHECK: { step: "QUALITY_CHECK", jobName: "quality-check", queue: "render", status: "QUALITY_CHECK", label: "Quality checking...", doneMessage: "Quality check passed", timeoutMs: 15 * MIN, attempts: 3 },
  GENERATE_METADATA: { step: "GENERATE_METADATA", jobName: "generate-metadata", queue: "pipeline", status: "QUALITY_CHECK", label: "Generating metadata...", doneMessage: "Metadata generated", timeoutMs: 5 * MIN, attempts: 3 },
  GENERATE_THUMBNAIL: { step: "GENERATE_THUMBNAIL", jobName: "generate-thumbnail", queue: "render", status: "QUALITY_CHECK", label: "Creating thumbnail...", doneMessage: "Thumbnail created", timeoutMs: 5 * MIN, attempts: 3 },
  CONTENT_QA: { step: "CONTENT_QA", jobName: "content-qa", queue: "pipeline", status: "QUALITY_CHECK", label: "Final English QA...", doneMessage: "Final English QA passed", timeoutMs: 2 * MIN, attempts: 3 },
  YOUTUBE_UPLOAD: { step: "YOUTUBE_UPLOAD", jobName: "youtube-upload", queue: "publish", status: "UPLOADING", label: "Uploading...", doneMessage: "Uploaded to YouTube", timeoutMs: 60 * MIN, attempts: 5 },
  YOUTUBE_PUBLISH: { step: "YOUTUBE_PUBLISH", jobName: "youtube-publish", queue: "publish", status: "UPLOADING", label: "Publishing...", doneMessage: "Publishing configured", timeoutMs: 5 * MIN, attempts: 5 },
};

/** Generation steps, in order. The video is READY after the last one. */
export const GENERATION_STEPS: PipelineStep[] = [
  "GENERATE_TOPIC",
  "RESEARCH_TOPIC",
  "GENERATE_SCRIPT",
  "VALIDATE_SCRIPT",
  "GENERATE_VOICE",
  "PLAN_VISUALS",
  "SEARCH_FOOTAGE",
  "SELECT_FOOTAGE",
  "GENERATE_SUBTITLES",
  "SELECT_MUSIC",
  "RENDER_VIDEO",
  "QUALITY_CHECK",
  "GENERATE_METADATA",
  "GENERATE_THUMBNAIL",
  "CONTENT_QA",
];

export const PUBLISH_STEPS: PipelineStep[] = ["YOUTUBE_UPLOAD", "YOUTUBE_PUBLISH"];

export const ALL_STEPS: PipelineStep[] = [...GENERATION_STEPS, ...PUBLISH_STEPS];

export function stepsFrom(step: PipelineStep): PipelineStep[] {
  const index = ALL_STEPS.indexOf(step);
  return index < 0 ? [] : ALL_STEPS.slice(index);
}

export function nextStepAfter(step: PipelineStep): PipelineStep | null {
  const order = GENERATION_STEPS.includes(step) ? GENERATION_STEPS : PUBLISH_STEPS;
  const index = order.indexOf(step);
  return order[index + 1] ?? null;
}

/** Partial regeneration targets offered in the UI and API. */
export const REGENERATION_TARGETS = {
  all: "GENERATE_TOPIC",
  research: "RESEARCH_TOPIC",
  script: "GENERATE_SCRIPT",
  voice: "GENERATE_VOICE",
  visuals: "PLAN_VISUALS",
  footage: "SEARCH_FOOTAGE",
  subtitles: "GENERATE_SUBTITLES",
  music: "SELECT_MUSIC",
  render: "RENDER_VIDEO",
  metadata: "GENERATE_METADATA",
  thumbnail: "GENERATE_THUMBNAIL",
} as const satisfies Record<string, PipelineStep>;

export type RegenerationTarget = keyof typeof REGENERATION_TARGETS;

const RENDER_TAIL: PipelineStep[] = ["RENDER_VIDEO", "QUALITY_CHECK", "GENERATE_THUMBNAIL", "CONTENT_QA"];

/**
 * After regenerating a step, which steps must re-run. Only genuinely dependent work is
 * redone: new metadata does not re-render the video, new music does not re-voice it.
 */
export function dependentSteps(step: PipelineStep): PipelineStep[] {
  switch (step) {
    case "GENERATE_METADATA":
      return ["GENERATE_METADATA", "GENERATE_THUMBNAIL", "CONTENT_QA"];
    case "GENERATE_THUMBNAIL":
      return ["GENERATE_THUMBNAIL", "CONTENT_QA"];
    case "SELECT_MUSIC":
      return ["SELECT_MUSIC", ...RENDER_TAIL];
    case "GENERATE_SUBTITLES":
      return ["GENERATE_SUBTITLES", ...RENDER_TAIL];
    case "SEARCH_FOOTAGE":
      return ["SEARCH_FOOTAGE", "SELECT_FOOTAGE", ...RENDER_TAIL];
    case "SELECT_FOOTAGE":
      return ["SELECT_FOOTAGE", ...RENDER_TAIL];
    case "RENDER_VIDEO":
      return RENDER_TAIL;
    default:
      return GENERATION_STEPS.slice(GENERATION_STEPS.indexOf(step));
  }
}

export const PROCESSING_STATUSES: VideoStatus[] = [
  "TOPIC_GENERATING",
  "RESEARCHING",
  "SCRIPT_GENERATING",
  "SCRIPT_REVIEW",
  "VOICE_GENERATING",
  "MEDIA_SEARCHING",
  "EDITING",
  "SUBTITLES_GENERATING",
  "RENDERING",
  "QUALITY_CHECK",
  "UPLOADING",
];
