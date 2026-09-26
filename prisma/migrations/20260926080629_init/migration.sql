-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "VideoStatus" AS ENUM ('DRAFT', 'TOPIC_GENERATING', 'RESEARCHING', 'SCRIPT_GENERATING', 'SCRIPT_REVIEW', 'VOICE_GENERATING', 'MEDIA_SEARCHING', 'EDITING', 'SUBTITLES_GENERATING', 'RENDERING', 'QUALITY_CHECK', 'READY', 'UPLOADING', 'SCHEDULED', 'PUBLISHED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PipelineStep" AS ENUM ('GENERATE_TOPIC', 'RESEARCH_TOPIC', 'GENERATE_SCRIPT', 'VALIDATE_SCRIPT', 'GENERATE_VOICE', 'PLAN_VISUALS', 'SEARCH_FOOTAGE', 'SELECT_FOOTAGE', 'GENERATE_SUBTITLES', 'SELECT_MUSIC', 'RENDER_VIDEO', 'QUALITY_CHECK', 'GENERATE_METADATA', 'GENERATE_THUMBNAIL', 'CONTENT_QA', 'YOUTUBE_UPLOAD', 'YOUTUBE_PUBLISH');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "TopicSource" AS ENUM ('MANUAL', 'AI');

-- CreateEnum
CREATE TYPE "TopicStatus" AS ENUM ('PROPOSED', 'USED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ResearchStatus" AS ENUM ('PENDING', 'COMPLETED', 'INSUFFICIENT', 'FAILED');

-- CreateEnum
CREATE TYPE "ClaimType" AS ENUM ('ESTABLISHED_FACT', 'UNCERTAIN', 'SPECULATION', 'OPINION');

-- CreateEnum
CREATE TYPE "ScriptVersionSource" AS ENUM ('AI', 'AI_REVISION', 'MANUAL');

-- CreateEnum
CREATE TYPE "ScriptVersionStatus" AS ENUM ('DRAFT', 'VALID', 'INVALID');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('VIDEO_CLIP', 'IMAGE', 'AUDIO_VOICE', 'AUDIO_MUSIC', 'AUDIO_SFX', 'SUBTITLE', 'RENDER', 'THUMBNAIL', 'OTHER');

-- CreateEnum
CREATE TYPE "MediaSource" AS ENUM ('PEXELS', 'ELEVENLABS', 'LOCAL_LIBRARY', 'GENERATED', 'UPLOAD', 'RENDERED');

-- CreateEnum
CREATE TYPE "PrivacyStatus" AS ENUM ('PRIVATE', 'UNLISTED', 'PUBLIC', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "PublishJobStatus" AS ENUM ('PENDING', 'UPLOADING', 'UPLOADED', 'SCHEDULED', 'PUBLISHED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "YouTubeAccountStatus" AS ENUM ('ACTIVE', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "projectId" UUID,
    "youtubeAccountId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "defaults" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YouTubeAccount" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "googleChannelId" TEXT NOT NULL,
    "channelTitle" TEXT NOT NULL,
    "channelThumbnail" TEXT,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "status" "YouTubeAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastError" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YouTubeAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopicCategory" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "promptHints" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "userId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopicCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoicePreset" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "gender" TEXT,
    "styles" TEXT[],
    "language" TEXT NOT NULL DEFAULT 'en',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "previewUrl" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "userId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoicePreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationTemplate" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL,
    "userId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Topic" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "projectId" UUID,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "angle" TEXT,
    "normalizedTitle" TEXT NOT NULL,
    "source" "TopicSource" NOT NULL,
    "status" "TopicStatus" NOT NULL DEFAULT 'PROPOSED',
    "scores" JSONB NOT NULL DEFAULT '{}',
    "overallScore" DOUBLE PRECISION,
    "researchStatus" "ResearchStatus" NOT NULL DEFAULT 'PENDING',
    "researchSummary" TEXT,
    "researchData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchReference" (
    "id" UUID NOT NULL,
    "topicId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publisher" TEXT,
    "snippet" TEXT,
    "reliability" DOUBLE PRECISION,
    "accessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchClaim" (
    "id" UUID NOT NULL,
    "topicId" UUID NOT NULL,
    "statement" TEXT NOT NULL,
    "type" "ClaimType" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "sourceUrls" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Video" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "channelId" UUID,
    "topicId" UUID,
    "templateId" UUID,
    "scheduleId" UUID,
    "status" "VideoStatus" NOT NULL DEFAULT 'DRAFT',
    "requestedTopic" TEXT,
    "autoTopic" BOOLEAN NOT NULL DEFAULT false,
    "category" TEXT NOT NULL,
    "targetDurationSec" INTEGER NOT NULL,
    "actualDurationSec" DOUBLE PRECISION,
    "voicePresetId" UUID,
    "voiceSettings" JSONB NOT NULL DEFAULT '{}',
    "musicMode" TEXT NOT NULL DEFAULT 'auto',
    "musicMood" TEXT,
    "musicTrackId" UUID,
    "sfxEnabled" BOOLEAN NOT NULL DEFAULT true,
    "title" TEXT,
    "description" TEXT,
    "hashtags" TEXT[],
    "tags" TEXT[],
    "thumbnailText" TEXT,
    "metadataLocked" BOOLEAN NOT NULL DEFAULT false,
    "renderAssetId" UUID,
    "thumbnailAssetId" UUID,
    "qualityReport" JSONB,
    "contentQaReport" JSONB,
    "autoPublish" BOOLEAN NOT NULL DEFAULT false,
    "privacy" "PrivacyStatus" NOT NULL DEFAULT 'PRIVATE',
    "scheduledPublishAt" TIMESTAMP(3),
    "youtubeAccountId" UUID,
    "youtubeVideoId" TEXT,
    "youtubeUrl" TEXT,
    "youtubeStatus" TEXT,
    "uploadedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "failedStep" "PipelineStep",
    "error" TEXT,
    "costEstimateUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Script" (
    "id" UUID NOT NULL,
    "videoId" UUID NOT NULL,
    "currentVersionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Script_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScriptVersion" (
    "id" UUID NOT NULL,
    "scriptId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "source" "ScriptVersionSource" NOT NULL,
    "status" "ScriptVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "hookStyle" TEXT,
    "hook" TEXT NOT NULL,
    "fullText" TEXT NOT NULL,
    "sections" JSONB NOT NULL,
    "wordCount" INTEGER NOT NULL,
    "estimatedDurationSec" DOUBLE PRECISION NOT NULL,
    "targetDurationSec" INTEGER NOT NULL,
    "wordsPerMinute" INTEGER NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "validation" JSONB,
    "aiModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScriptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "kind" "MediaKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "durationSec" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "fps" DOUBLE PRECISION,
    "source" "MediaSource" NOT NULL,
    "sourceId" TEXT,
    "sourceUrl" TEXT,
    "author" TEXT,
    "authorUrl" TEXT,
    "license" TEXT,
    "licenseUrl" TEXT,
    "checksum" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Voiceover" (
    "id" UUID NOT NULL,
    "videoId" UUID NOT NULL,
    "scriptVersionId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL,
    "voiceName" TEXT,
    "modelId" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "cacheKey" TEXT NOT NULL,
    "durationSec" DOUBLE PRECISION NOT NULL,
    "alignment" JSONB,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Voiceover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoScene" (
    "id" UUID NOT NULL,
    "videoId" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "startSec" DOUBLE PRECISION NOT NULL,
    "endSec" DOUBLE PRECISION NOT NULL,
    "narration" TEXT NOT NULL,
    "visualDescription" TEXT NOT NULL,
    "keywords" TEXT[],
    "fallbackKeywords" TEXT[],
    "transition" TEXT NOT NULL DEFAULT 'cut',
    "mediaAssetId" UUID,
    "candidates" JSONB NOT NULL DEFAULT '[]',
    "searchLog" JSONB NOT NULL DEFAULT '[]',
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoScene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subtitle" (
    "id" UUID NOT NULL,
    "videoId" UUID NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "provider" TEXT NOT NULL,
    "styleKey" TEXT NOT NULL,
    "transcript" TEXT NOT NULL,
    "detectedLanguage" TEXT,
    "words" JSONB NOT NULL,
    "cues" JSONB NOT NULL,
    "assetId" UUID,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subtitle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MusicTrack" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "title" TEXT NOT NULL,
    "artist" TEXT,
    "moods" TEXT[],
    "bpm" INTEGER,
    "durationSec" DOUBLE PRECISION NOT NULL,
    "assetId" UUID NOT NULL,
    "source" "MediaSource" NOT NULL,
    "license" TEXT NOT NULL,
    "licenseUrl" TEXT,
    "attribution" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MusicTrack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationJob" (
    "id" UUID NOT NULL,
    "videoId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "step" "PipelineStep" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "queueName" TEXT NOT NULL,
    "queueJobId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "output" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishJob" (
    "id" UUID NOT NULL,
    "videoId" UUID NOT NULL,
    "youtubeAccountId" UUID NOT NULL,
    "status" "PublishJobStatus" NOT NULL DEFAULT 'PENDING',
    "privacy" "PrivacyStatus" NOT NULL,
    "publishAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "youtubeVideoId" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channelId" UUID,
    "templateId" UUID,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "autoMode" BOOLEAN NOT NULL DEFAULT true,
    "daysOfWeek" INTEGER[],
    "times" TEXT[],
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "videosPerRun" INTEGER NOT NULL DEFAULT 1,
    "categories" TEXT[],
    "voicePresetId" UUID,
    "durationSec" INTEGER NOT NULL DEFAULT 30,
    "musicMode" TEXT NOT NULL DEFAULT 'auto',
    "privacy" "PrivacyStatus" NOT NULL DEFAULT 'PRIVATE',
    "autoPublish" BOOLEAN NOT NULL DEFAULT true,
    "publishDelayMin" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsSnapshot" (
    "id" UUID NOT NULL,
    "videoId" UUID NOT NULL,
    "youtubeVideoId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "views" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "watchTimeMinutes" DOUBLE PRECISION,
    "averageViewDuration" DOUBLE PRECISION,
    "averageViewPercentage" DOUBLE PRECISION,
    "subscribersGained" INTEGER,
    "subscribersLost" INTEGER,
    "raw" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "AnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceInsight" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "dimension" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "avgViews" DOUBLE PRECISION NOT NULL,
    "avgViewPct" DOUBLE PRECISION,
    "avgLikes" DOUBLE PRECISION,
    "score" DOUBLE PRECISION NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformanceInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemLog" (
    "id" UUID NOT NULL,
    "level" "LogLevel" NOT NULL,
    "message" TEXT NOT NULL,
    "userId" UUID,
    "videoId" UUID,
    "jobId" TEXT,
    "step" "PipelineStep",
    "provider" TEXT,
    "durationMs" INTEGER,
    "error" TEXT,
    "context" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiCache" (
    "key" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiCache_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Project_userId_idx" ON "Project"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_userId_name_key" ON "Project"("userId", "name");

-- CreateIndex
CREATE INDEX "Channel_userId_idx" ON "Channel"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_userId_name_key" ON "Channel"("userId", "name");

-- CreateIndex
CREATE INDEX "YouTubeAccount_userId_idx" ON "YouTubeAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "YouTubeAccount_userId_googleChannelId_key" ON "YouTubeAccount"("userId", "googleChannelId");

-- CreateIndex
CREATE UNIQUE INDEX "AppSetting_userId_key_key" ON "AppSetting"("userId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "TopicCategory_key_key" ON "TopicCategory"("key");

-- CreateIndex
CREATE UNIQUE INDEX "VoicePreset_provider_voiceId_key" ON "VoicePreset"("provider", "voiceId");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationTemplate_key_key" ON "GenerationTemplate"("key");

-- CreateIndex
CREATE INDEX "Topic_userId_createdAt_idx" ON "Topic"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Topic_userId_category_idx" ON "Topic"("userId", "category");

-- CreateIndex
CREATE INDEX "ResearchReference_topicId_idx" ON "ResearchReference"("topicId");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchReference_topicId_url_key" ON "ResearchReference"("topicId", "url");

-- CreateIndex
CREATE INDEX "ResearchClaim_topicId_idx" ON "ResearchClaim"("topicId");

-- CreateIndex
CREATE UNIQUE INDEX "Video_youtubeVideoId_key" ON "Video"("youtubeVideoId");

-- CreateIndex
CREATE INDEX "Video_userId_status_idx" ON "Video"("userId", "status");

-- CreateIndex
CREATE INDEX "Video_userId_createdAt_idx" ON "Video"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Video_scheduleId_idx" ON "Video"("scheduleId");

-- CreateIndex
CREATE UNIQUE INDEX "Script_videoId_key" ON "Script"("videoId");

-- CreateIndex
CREATE UNIQUE INDEX "Script_currentVersionId_key" ON "Script"("currentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "ScriptVersion_scriptId_version_key" ON "ScriptVersion"("scriptId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_storageKey_key" ON "MediaAsset"("storageKey");

-- CreateIndex
CREATE INDEX "MediaAsset_source_sourceId_idx" ON "MediaAsset"("source", "sourceId");

-- CreateIndex
CREATE INDEX "MediaAsset_kind_idx" ON "MediaAsset"("kind");

-- CreateIndex
CREATE INDEX "MediaAsset_checksum_idx" ON "MediaAsset"("checksum");

-- CreateIndex
CREATE INDEX "Voiceover_videoId_isCurrent_idx" ON "Voiceover"("videoId", "isCurrent");

-- CreateIndex
CREATE INDEX "Voiceover_cacheKey_idx" ON "Voiceover"("cacheKey");

-- CreateIndex
CREATE UNIQUE INDEX "VideoScene_videoId_index_key" ON "VideoScene"("videoId", "index");

-- CreateIndex
CREATE INDEX "Subtitle_videoId_isCurrent_idx" ON "Subtitle"("videoId", "isCurrent");

-- CreateIndex
CREATE INDEX "MusicTrack_enabled_idx" ON "MusicTrack"("enabled");

-- CreateIndex
CREATE INDEX "GenerationJob_videoId_step_status_idx" ON "GenerationJob"("videoId", "step", "status");

-- CreateIndex
CREATE INDEX "GenerationJob_userId_createdAt_idx" ON "GenerationJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationJob_status_idx" ON "GenerationJob"("status");

-- CreateIndex
CREATE INDEX "PublishJob_videoId_idx" ON "PublishJob"("videoId");

-- CreateIndex
CREATE INDEX "PublishJob_status_idx" ON "PublishJob"("status");

-- CreateIndex
CREATE INDEX "Schedule_userId_idx" ON "Schedule"("userId");

-- CreateIndex
CREATE INDEX "Schedule_enabled_nextRunAt_idx" ON "Schedule"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "AnalyticsSnapshot_videoId_capturedAt_idx" ON "AnalyticsSnapshot"("videoId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceInsight_userId_dimension_value_key" ON "PerformanceInsight"("userId", "dimension", "value");

-- CreateIndex
CREATE INDEX "SystemLog_videoId_createdAt_idx" ON "SystemLog"("videoId", "createdAt");

-- CreateIndex
CREATE INDEX "SystemLog_userId_createdAt_idx" ON "SystemLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SystemLog_level_createdAt_idx" ON "SystemLog"("level", "createdAt");

-- CreateIndex
CREATE INDEX "ApiCache_namespace_idx" ON "ApiCache"("namespace");

-- CreateIndex
CREATE INDEX "ApiCache_expiresAt_idx" ON "ApiCache"("expiresAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_youtubeAccountId_fkey" FOREIGN KEY ("youtubeAccountId") REFERENCES "YouTubeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YouTubeAccount" ADD CONSTRAINT "YouTubeAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppSetting" ADD CONSTRAINT "AppSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicCategory" ADD CONSTRAINT "TopicCategory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoicePreset" ADD CONSTRAINT "VoicePreset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationTemplate" ADD CONSTRAINT "GenerationTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Topic" ADD CONSTRAINT "Topic_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Topic" ADD CONSTRAINT "Topic_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchReference" ADD CONSTRAINT "ResearchReference_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchClaim" ADD CONSTRAINT "ResearchClaim_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "GenerationTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_musicTrackId_fkey" FOREIGN KEY ("musicTrackId") REFERENCES "MusicTrack"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_renderAssetId_fkey" FOREIGN KEY ("renderAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_thumbnailAssetId_fkey" FOREIGN KEY ("thumbnailAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Script" ADD CONSTRAINT "Script_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Script" ADD CONSTRAINT "Script_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "ScriptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScriptVersion" ADD CONSTRAINT "ScriptVersion_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "Script"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voiceover" ADD CONSTRAINT "Voiceover_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voiceover" ADD CONSTRAINT "Voiceover_scriptVersionId_fkey" FOREIGN KEY ("scriptVersionId") REFERENCES "ScriptVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voiceover" ADD CONSTRAINT "Voiceover_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoScene" ADD CONSTRAINT "VideoScene_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoScene" ADD CONSTRAINT "VideoScene_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subtitle" ADD CONSTRAINT "Subtitle_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subtitle" ADD CONSTRAINT "Subtitle_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MusicTrack" ADD CONSTRAINT "MusicTrack_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MusicTrack" ADD CONSTRAINT "MusicTrack_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_youtubeAccountId_fkey" FOREIGN KEY ("youtubeAccountId") REFERENCES "YouTubeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "GenerationTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsSnapshot" ADD CONSTRAINT "AnalyticsSnapshot_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceInsight" ADD CONSTRAINT "PerformanceInsight_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemLog" ADD CONSTRAINT "SystemLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemLog" ADD CONSTRAINT "SystemLog_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
