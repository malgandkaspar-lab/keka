import type { PipelineStep } from "@/generated/prisma/client";
import {
  contentQaHandler,
  generateMetadataHandler,
  generateScriptHandler,
  generateTopicHandler,
  researchTopicHandler,
  validateScriptHandler,
} from "./handlers/content";
import {
  generateSubtitlesHandler,
  generateVoiceHandler,
  planVisualsHandler,
  searchFootageHandler,
  selectFootageHandler,
  selectMusicHandler,
} from "./handlers/media";
import { youtubePublishHandler, youtubeUploadHandler } from "./handlers/publish";
import { generateThumbnailHandler, qualityCheckHandler, renderVideoHandler } from "./handlers/render";
import type { StepHandler } from "./types";

/** Maps every pipeline step to its handler. */
export const STEP_HANDLERS: Record<PipelineStep, StepHandler> = {
  GENERATE_TOPIC: generateTopicHandler,
  RESEARCH_TOPIC: researchTopicHandler,
  GENERATE_SCRIPT: generateScriptHandler,
  VALIDATE_SCRIPT: validateScriptHandler,
  GENERATE_VOICE: generateVoiceHandler,
  PLAN_VISUALS: planVisualsHandler,
  SEARCH_FOOTAGE: searchFootageHandler,
  SELECT_FOOTAGE: selectFootageHandler,
  GENERATE_SUBTITLES: generateSubtitlesHandler,
  SELECT_MUSIC: selectMusicHandler,
  RENDER_VIDEO: renderVideoHandler,
  QUALITY_CHECK: qualityCheckHandler,
  GENERATE_METADATA: generateMetadataHandler,
  GENERATE_THUMBNAIL: generateThumbnailHandler,
  CONTENT_QA: contentQaHandler,
  YOUTUBE_UPLOAD: youtubeUploadHandler,
  YOUTUBE_PUBLISH: youtubePublishHandler,
};
