# Service reference

Each major service with its purpose, inputs, outputs, errors, provider, configuration and example usage. All services live in `src/services/`, and all errors come from `src/lib/errors.ts`. Every `AppError` has a stable `code`, an HTTP `statusCode` and a `retryable` flag that the job system uses to decide whether a retry can help.

---

## LanguageService - `language/language-service.ts`

- **Purpose:** programmatic English-only validation of all generated text.
- **Inputs:** a text plus a kind (`topic`, `research`, `script`, `title`, `description`, `hashtags`, `tags`, `subtitles`, `thumbnail`), or a full content bundle.
- **Outputs:** `LanguageAnalysis { isEnglish, confidence, reasons, metrics }`, or `BundleReport { passed, failedFields }`.
- **Method:** non-Latin script ratio, non-English diacritics, coverage by a 275k-word English dictionary (proper nouns excluded in prose), franc trigram detection for longer text, and a sentence-level scan.
- **Errors:** `assertEnglish` throws `LanguageValidationError` (retryable by default, so the content is regenerated).
- **Example:** `assertEnglish(script, "script")`, `validateBundle({ title, description, hashtags })`.

## AIProvider / AnthropicProvider - `ai/`

- **Purpose:** provider-neutral structured text generation and web research.
- **Inputs:** a system prompt, a user prompt, a Zod schema, an effort level and an AbortSignal.
- **Outputs:** `{ data, usage: { inputTokens, outputTokens, webSearches, costUsd, model } }`. Research returns `{ notes, sources }`.
- **Provider:** Claude through `@anthropic-ai/sdk` (`beta.messages.parse` with `betaZodOutputFormat`, adaptive thinking, `web_search_20260209`, `fallbacks: "default"` on Opus 5 / Fable models).
- **Errors:** `RateLimitError`, `ExternalServiceError` (retryable for 5xx and connection errors), `ContentPolicyError` on refusals, `MissingCredentialError`.
- **Configuration:** `ANTHROPIC_API_KEY`; model and effort in user settings.
- **Example:** `getAIProvider(settings).generateStructured({ purpose: "x", system, prompt, schema })`.

## TopicService - `topics/topic-service.ts`

- **Purpose:** manual topics (validated) and AI-selected topics with scoring and deduplication.
- **Inputs:** user, category, AI provider, minimum score, similarity threshold, performance hints.
- **Outputs:** a `Topic` row with the seven scores and the overall weighted score, plus the rejected candidates and why.
- **Errors:** `ValidationError`, `LanguageValidationError`, `ContentPolicyError`, `ConflictError` (no novel topic after 3 rounds).
- **Example:** `generateTopic({ userId, categoryKey: "space", ai, minScore: 6.5, similarityThreshold: 0.55 })`.

## ResearchService - `research/research-service.ts`

- **Purpose:** sourced research before any factual script, with claims classified as `ESTABLISHED_FACT` / `UNCERTAIN` / `SPECULATION` / `OPINION`.
- **Outputs:** `ResearchReference` and `ResearchClaim` rows, a summary, and a status of `COMPLETED` or `INSUFFICIENT` (fewer than 3 reliably sourced facts).
- **Provider:** `AIProvider.researchWithWebSearch` followed by a structured extraction that may only cite consulted URLs. Domains get a reliability score.
- **Caching:** 30 days per topic (`ApiCache`).

## ScriptService - `scripts/`

- **Purpose:** one-fact Shorts scripts: HOOK (the fact itself, max 12 words, no intro, not a question) -> CURIOSITY (one surprising detail) -> INFORMATION (2-3 sentences on why) -> CTA (an easy question for viewers), 60-90 words. Titles are at most 50 characters; videos use 5-7 scenes.
- **Duration:** `estimateSpeechDurationSec(text, wpm)` counts spoken numbers and adds pauses. `targetWordCount(duration, wpm)` gives the word budget.
- **QC:** `programmaticChecks` covers English, duration, hook length, conclusion, repetition, long sentences, formatting (stage directions, emojis, URLs, hashtags), content policy and reused hooks. `reviewScript` (AI) covers grammar, factual consistency against research, unsupported claims, misleading hooks and scores.
- **Outputs:** versioned `ScriptVersion` rows (`AI`, `AI_REVISION`, `MANUAL`) with their validation report.
- **Example:** `draftScript(ai, ctx)` → `validateDraft(ai, draft, ctx)` → `saveScriptVersion(...)`.

## VoiceoverService / TTSProvider - `tts/`

- **Purpose:** English narration from a validated script, never translated.
- **Provider:** ElevenLabs `/v1/text-to-speech/{voice}/with-timestamps` (character alignment). `language_code=en` is sent on models that support it.
- **Outputs:** a `Voiceover` row (voice id, model, settings, duration, audio asset, word timings, metadata).
- **Cost control:** a cache key of text + voice + model + settings reuses earlier audio.
- **Duration control:** narration more than 15% over the target is re-synthesised once, faster (≤1.15×).
- **SpeechToTextProvider:** ElevenLabs Scribe (default) or OpenAI Whisper, language forced to English, with word timestamps.

## Scene planner / FootageService / VideoProvider - `footage/`

- **Purpose:** turn narration into shots and find licensed footage for each one.
- **Segmentation:** `segmentNarration(words, duration, style)` uses the real voiceover timings, respects the template's shot lengths and prefers punctuation boundaries.
- **Visual plan (AI):** a description, keywords, fallback keywords and a transition per shot, plus the music mood.
- **Search:** portrait → any orientation → fallback keywords → video-level keywords → still images → reuse of another scene's clip.
- **Ranking:** relevance, vertical orientation, resolution, duration, and uniqueness within the video and across recent videos.
- **Provider:** Pexels (`videos/search`, `v1/search`), responses cached for 7 days, downloads restricted to Pexels hosts. Each asset records its source URL, author and license.

## SubtitleService - `subtitles/`

- **Purpose:** accurate English subtitles from the final voiceover audio.
- **Process:**
  1. Transcribe the audio (STT).
  2. Validate that the transcript is English and that its word error rate against the script is ≤35%.
  3. Align the transcript onto the script's exact wording with LCS.
  4. Build short, width-aware cues.
  5. Render ASS (styles FAST VIRAL / CINEMATIC / MINIMAL, with pop or fade animation and highlighting of the current word).
- **Fallback:** TTS character timestamps when STT is unavailable.
- **Errors:** `LanguageValidationError`; `QualityCheckError` when the voice does not match the script.

## MusicService / MusicProvider - `music/`

- **Providers:**
  1. `LocalLibraryMusicProvider`: licensed uploads, where the license field is mandatory.
  2. `ProceduralMusicProvider`: mood beds synthesised with FFmpeg, royalty-free by construction, reused per mood.
- **SFX:** synthesised whoosh, impact, riser and click variants, used sparingly and varied per video.

## RenderEngine - `video/render-engine.ts`

- **Inputs:** scenes with local media paths and timings, voice, music, SFX, ASS file, template style.
- **Output:** a 1080×1920, 30 fps H.264/AAC MP4 with `+faststart`, plus clean scene segments for the thumbnail.
- **Errors:** `MediaProcessingError` (includes the tail of FFmpeg's stderr), `TimeoutError`, `CancelledError`.

## QualityControlService - `quality/quality-service.ts`

- **Checks:**
  - decodes cleanly, MP4 container, H.264 + AAC, 1080×1920, ~30 fps, yuv420p
  - duration matches the narration (5-180 s)
  - audio present, audible (mean > −32 dB) and not clipping
  - no long silences or black frames
  - every scene has media and the scenes cover the timeline
  - subtitles exist and are English, voiceover is English
- **Output:** `QualityReport { passed, checks[] }`. Retryable failures re-render once; others fail the video.

## MetadataService - `metadata/metadata-service.ts`

- **Outputs:** English title (≤100 characters), description (≤5000), 3-5 hashtags including #Shorts, tags (≤500 characters in total) and thumbnail text (≤5 words).
- **Checks:** English, all-caps titles, near-duplicate titles and content policy. Failures regenerate with the reasons fed back to the AI.

## YouTubeService / YouTubeProvider - `youtube/`

- **OAuth:** HMAC-signed, user-bound, single-use state; tokens encrypted with AES-256-GCM; refreshed tokens persisted automatically.
- **Upload:** a final English gate; duplicate protection (never re-uploads a video that has a YouTube ID, and retries adopt an upload that already reached YouTube); privacy private / unlisted / public / scheduled (`publishAt`); `containsSyntheticMedia=true`.
- **Publish:** sets the thumbnail (warns when the channel is not verified) and syncs privacy and schedule status.
- **Analytics:** Data API statistics plus Analytics API metrics (watch time, average view duration and percentage, subscriber changes). Unavailable metrics are stored as `null`, never guessed.

## Pipeline orchestrator - `pipeline/`

- `startOrResume(videoId)` enqueues the first incomplete step.
- `regenerate(videoId, step)` supersedes the step and its dependants.
- `cancel(videoId)` removes waiting jobs and aborts running handlers.
- `requestPublish(videoId)` queues the upload.
- `reconcilePipeline()` recovers state after a crash.

## SchedulerService - `publishing/scheduler-service.ts`

- **Inputs:** days of week, `HH:MM` times, IANA time zone, videos per run, categories (rotated), voice, template, duration, music, privacy, auto-publish, publish delay.
- `computeNextRun` handles time zones and DST. `runDueSchedules` claims due schedules optimistically, so several workers never double-run one.

## StorageService - `storage/`

- **Interface:** `upload`, `uploadFile`, `download`, `downloadToFile`, `createReadStream(range)`, `stat`, `delete`, `exists`, `getUrl`.
- **Providers:** `LocalStorageProvider` (atomic writes, path-traversal safe) and `S3StorageProvider` (any S3-compatible service, pre-signed URLs).
- `materialize(key, workDir)` gives FFmpeg a local file for any provider.
