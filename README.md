this is a new project

# Shorts Factory

Shorts Factory automatically creates English YouTube Shorts from a topic and publishes them to YouTube.

```
TOPIC → RESEARCH → SCRIPT → SCRIPT QC → VOICEOVER → VISUAL PLAN → STOCK FOOTAGE → EDITING
→ SUBTITLES → MUSIC → SOUND DESIGN → FINAL RENDER → QUALITY CONTROL → TITLE / DESCRIPTION /
HASHTAGS → FINAL ENGLISH QA → YOUTUBE UPLOAD → SCHEDULE / PUBLISH → ANALYTICS
```

You enter a topic (for example *"Why do astronauts grow taller in space?"*) or let the AI choose one, then click **GENERATE SHORT**. The system then:

1. Researches the topic with live web search and classifies each claim as established fact, uncertain, speculation or opinion.
2. Writes an English script built for Shorts: hook, curiosity, information, escalation, payoff.
3. Validates the script: English, length, pacing, repetition, facts, policy, hook and conclusion. It revises automatically when a check fails.
4. Generates an English voiceover with ElevenLabs.
5. Plans scenes from the real word timings of the voiceover and finds licensed Pexels footage for each scene.
6. Transcribes the final audio (English) to produce word-accurate, animated subtitles.
7. Adds royalty-free music with automatic ducking, plus sparse sound effects.
8. Renders a 1080×1920, 30 fps H.264/AAC MP4 with FFmpeg.
9. Runs quality control: decoding, resolution, fps, duration, audibility, clipping, silence, black frames, scene coverage, subtitle and voice language.
10. Generates the English title, description, hashtags, tags and thumbnail.
11. Runs a mandatory final English QA. Nothing non-English is ever uploaded.
12. Uploads to YouTube as private, unlisted, public or scheduled, with duplicate protection.
13. Collects analytics and feeds what performed well back into topic and hook selection.

Every step is persisted, so a failed step can be retried without repeating earlier work. Any component (script, voice, footage, subtitles, music, metadata, thumbnail) can be regenerated or edited by hand on its own.

## Free mode: no API costs (default)

Out of the box, Shorts Factory uses only free services and local open-source models:

| Part | Free provider (default) | Optional paid alternative |
|---|---|---|
| Topic, research planning, script, review, visual plan, metadata | **Ollama** running an open model locally (default `qwen2.5:7b`) | Anthropic Claude |
| Research sources | **Wikipedia** (MediaWiki API, no key) | Claude web search |
| Voiceover | **Kokoro-82M** English (11 English voices), runs in the worker | ElevenLabs |
| Subtitles / word timings | **NVIDIA Parakeet TDT 0.6B v2** (English), runs in the worker | ElevenLabs Scribe, OpenAI Whisper |
| Stock footage | **Pexels** (free API key) | – |
| Music and sound effects | Your licensed library, or royalty-free beds synthesised locally | – |
| Publishing and analytics | **YouTube Data / Analytics API** (free, quota-limited) | – |

What you need:
1. **Ollama:** install it from <https://ollama.com>, then run `ollama pull qwen2.5:7b` once. With Docker Compose this is automatic.
2. **A free Pexels API key** from <https://www.pexels.com/api/>.
3. **A free Google Cloud OAuth client** for YouTube (see [YouTube OAuth](#youtube-oauth)).

The voice and subtitle models (about 600 MB) download automatically from their official GitHub releases on first use and are then reused.

Hardware: a 7B model needs about 8 GB of free RAM. 16 GB total RAM is recommended; a GPU makes text generation much faster. On a 4-core CPU:
- Kokoro renders speech at about real time (30 s of narration in about 30 s).
- Parakeet transcribes 30 s in about 1 s.
- Ollama on CPU takes a few minutes per video (seconds with a GPU).

On a machine with less RAM, use a smaller model such as `qwen2.5:3b` (**Settings → AI → Local model**). Smaller models write weaker scripts, but the automatic quality control and revision loop still enforces English, length and structure.

Paid providers are optional and can be selected per user in **Settings**.

**English only.** All generated content is English. The script, research, topic, title, description, hashtags, tags, subtitles, thumbnail text and voiceover transcript pass through a programmatic language validator (`src/services/language`), not just a prompt instruction. Non-English output is rejected and regenerated.

---

## Contents

- [Requirements](#requirements)
- [Quick start with Docker](#quick-start-with-docker)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [External services](#external-services): Claude, ElevenLabs, Pexels, YouTube OAuth
- [Database and Prisma migrations](#database-and-prisma-migrations)
- [Redis and background jobs](#redis-and-background-jobs)
- [FFmpeg](#ffmpeg)
- [Using the app](#using-the-app)
- [Testing](#testing)
- [Production deployment](#production-deployment)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)

## Requirements

| Component | Version |
|---|---|
| Node.js | 22 (20.9+ works) |
| PostgreSQL | 14+ (16 recommended) |
| Redis | 6.2+ (7 recommended, with AOF persistence) |
| FFmpeg / FFprobe | 6.x with `libx264`, `aac`, `libass`, `libfreetype` |
| Fonts | DejaVu (`fonts-dejavu-core`) for subtitles and thumbnails |
| Free mode | Ollama + a pulled model; a free Pexels key; a free Google OAuth client for YouTube |
| Optional paid APIs | Anthropic, ElevenLabs, OpenAI (only if you select them) |

## Quick start with Docker

**Easiest:** install [Docker Desktop](https://www.docker.com/products/docker-desktop) and start it. Then download this project (GitHub → **Code → Download ZIP**, then unzip, or `git clone`), open a terminal in the project folder and run one command:

```bash
./setup.sh          # macOS / Linux
```

On Windows, double-click **`setup.cmd`** in the project folder (or run `powershell -ExecutionPolicy Bypass -File .\setup.ps1`; plain `.\setup.ps1` is blocked by the default PowerShell script policy).

The script creates `.env` with freshly generated secrets, asks for your free Pexels key and starts everything. Then open <http://localhost:3000>.

Manual setup:

```bash
cp .env.example .env
# Fill in AUTH_SECRET, ENCRYPTION_KEY and the API keys (see below)
openssl rand -base64 48   # -> AUTH_SECRET
openssl rand -base64 32   # -> ENCRYPTION_KEY

docker compose up --build
```

Open <http://localhost:3000> and create the administrator account. The first account becomes the admin; after that, registration is closed unless `ALLOW_REGISTRATION=true`.

The stack has five services:

| Service | Purpose |
|---|---|
| `postgres` | Database (volume `pgdata`) |
| `redis` | Queues, with AOF persistence and `noeviction` (volume `redisdata`) |
| `migrate` | One-shot: `prisma migrate deploy` + seed data (categories, templates, voices) |
| `app` | Next.js web app on port 3000 (`/api/health` health check) |
| `worker` | BullMQ worker: generation, rendering, uploads, scheduler, analytics |

`app` and `worker` share the `media` volume, where the local storage driver keeps files.

## Local development

```bash
npm install                       # also runs `prisma generate`
cp .env.example .env              # fill in values

# PostgreSQL + Redis (or use your own)
docker compose up -d postgres redis

npm run db:migrate                # prisma migrate deploy
npm run db:seed                   # categories, templates, English voices

npm run dev                       # web app on http://localhost:3000
npm run worker:dev                # background worker (separate terminal)
```

Generation never runs inside an HTTP request. The web app only enqueues jobs, so **the worker must be running** for videos to progress.

Useful scripts:

| Script | What it does |
|---|---|
| `npm run typecheck` | Route type generation + `tsc --noEmit` (strict) |
| `npm run lint` | ESLint (Next.js + TypeScript rules) |
| `npm test` | Unit + integration tests (Vitest) |
| `npm run test:e2e` | Browser tests (Playwright) against a running instance |
| `npm run build` / `npm start` | Production build / server |
| `npm run worker` | Production worker |
| `npm run e2e:real -- --email you@example.com [--upload]` | Real end-to-end run with the real APIs (see [Testing](#testing)) |

## Environment variables

Everything is configured through environment variables (see `.env.example`). Secrets are only read on the server and are never sent to the browser. Missing API keys do not crash the app: the step that needs one fails with a clear message naming the variable (for example `Missing credential: set the PEXELS_API_KEY environment variable`), and the Settings page shows which integrations are configured.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `REDIS_URL` | yes | Redis connection string |
| `APP_URL` | yes | Public URL, used for OAuth redirects and secure cookies |
| `AUTH_SECRET` | yes | ≥32 characters; signs OAuth state |
| `ENCRYPTION_KEY` | yes | 32 bytes, base64; AES-256-GCM encryption of OAuth tokens |
| `ALLOW_REGISTRATION` | no | `true` allows more accounts after the first admin |
| `OLLAMA_BASE_URL` | free mode | Local Ollama server (default `http://localhost:11434`) |
| `OLLAMA_MODEL` | no | Default local model (`qwen2.5:7b`); changeable per user |
| `LOCAL_MODELS_DIR` | no | Where Kokoro/Parakeet models are stored (default `./storage/models`) |
| `LOCAL_AI_THREADS` | no | CPU threads for the local voice/subtitle engines (default 4) |
| `ANTHROPIC_API_KEY` | only if Claude is selected | Claude API key |
| `ANTHROPIC_MODEL` | no | Default model (`claude-opus-5`); changeable per user |
| `ELEVENLABS_API_KEY` | only if ElevenLabs is selected | ElevenLabs API key |
| `OPENAI_API_KEY` | no | Only if you choose Whisper for speech-to-text |
| `PEXELS_API_KEY` | for footage | Pexels API key (free) |
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` / `YOUTUBE_REDIRECT_URI` | for publishing | Google OAuth client |
| `STORAGE_DRIVER` | no | `local` (default) or `s3` |
| `STORAGE_LOCAL_DIR` | no | Local storage root (default `./storage`) |
| `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`, `STORAGE_FORCE_PATH_STYLE` | for S3 | Any S3-compatible service (AWS S3, Cloudflare R2, MinIO, Backblaze B2) |
| `FFMPEG_PATH`, `FFPROBE_PATH`, `FONTS_DIR`, `WORK_DIR` | no | Media tool locations |
| `WORKER_CONCURRENCY`, `RENDER_CONCURRENCY` | no | Worker parallelism (defaults 2 and 1) |
| `LOG_LEVEL` | no | `trace` … `error` |

## External services

### Ollama (free, local)

1. Install Ollama from <https://ollama.com> (macOS, Windows, Linux) and make sure it is running.
2. Run `ollama pull qwen2.5:7b` once (about 4.7 GB).
3. Keep the default `OLLAMA_BASE_URL=http://localhost:11434`. In Docker Compose the `ollama` service is used automatically.
4. **Settings → Free local AI** shows whether Ollama is reachable and the model is installed.

Other good models: `qwen2.5:14b` (better, needs about 16 GB RAM), `llama3.1:8b`, `qwen2.5:3b` (low RAM). Structured JSON output is validated with Zod; invalid output is sent back to the model for repair.

### Kokoro voice and Parakeet subtitles (free, local)

Both run inside the worker through `sherpa-onnx` (prebuilt for Linux, macOS and Windows). No key and no per-use cost. The models download once from the official `k2-fsa/sherpa-onnx` GitHub releases:
- `kokoro-int8-en-v0_19` (Apache-2.0): English-only, 11 voices
- `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` (CC-BY-4.0): English, with timestamps

Only speed is adjustable for Kokoro. Script length is calibrated automatically to each voice's measured speaking rate, so videos match the target duration.

### Claude API (Anthropic, optional, paid)

1. Create an API key at <https://console.anthropic.com> and set `ANTHROPIC_API_KEY`.
2. The default model is `claude-opus-5`, with adaptive thinking and structured JSON outputs validated by Zod. Research uses Claude's server-side web search tool. On Opus 5 and Fable models, server-side refusal fallbacks (`fallbacks: "default"`) are enabled.
3. Change the model or effort in **Settings → AI**. The provider sits behind the `AIProvider` interface (`src/services/ai/types.ts`), so another provider can be added later.

Cost: every AI call records token usage and an estimated cost (`src/config/pricing.ts`). Research results are cached for 30 days.

### ElevenLabs (optional, paid)

1. Create an API key at <https://elevenlabs.io/app/settings/api-keys> and set `ELEVENLABS_API_KEY`.
2. The key is used for **text-to-speech** (with character timestamps) and **Scribe speech-to-text** (language forced to English, word timestamps) for subtitles.
3. Eight premade English voices are seeded. Use **Settings → Sync voices from ElevenLabs** to import every English-capable voice on your account. Non-English voices are skipped.
4. Supported voice settings: stability, similarity, style, speaker boost and speed (0.7-1.2). Unsupported parameters are never sent. The `eleven_turbo_v2_5` and `eleven_flash_v2_5` models also enforce English with `language_code=en`.
5. Identical text + voice + settings reuse cached audio, so you are never charged twice.

### Pexels

1. Get a free API key at <https://www.pexels.com/api/> and set `PEXELS_API_KEY`.
2. Footage is searched per scene: vertical first, then any orientation (cropped to 9:16 with a slow pan), broader keywords, video-level fallbacks, then still images with Ken Burns motion. A scene is never left blank.
3. Every asset stores its source URL, author and license (Pexels License). Descriptions credit the footage authors.
4. Search responses are cached for 7 days to stay within the API rate limit.

### YouTube OAuth

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable **YouTube Data API v3** and **YouTube Analytics API**.
2. Configure the **OAuth consent screen** (External). Add the scopes `youtube.upload`, `youtube.readonly` and `yt-analytics.readonly`, and add yourself as a test user while the app is in testing.
3. Create an **OAuth client ID** of type **Web application** and add the authorised redirect URI `${APP_URL}/api/youtube/callback` (for example `http://localhost:3000/api/youtube/callback`).
4. Set `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` and `YOUTUBE_REDIRECT_URI` (the same URI).
5. In the app, open **YouTube → Connect channel**. You sign in on Google's page; the app never sees your Google password. Tokens are encrypted at rest.

Notes:
- Videos uploaded through an unverified Google API project are locked to private by YouTube until the project passes the [audit](https://support.google.com/youtube/contact/yt_api_form). Private uploads work immediately.
- Custom thumbnails require a phone-verified channel. Without one, the upload still succeeds and a warning is logged.
- The default quota (10,000 units per day) allows about six uploads per day (1,600 units each).
- AI narration is disclosed through YouTube's `containsSyntheticMedia` flag.

## Database and Prisma migrations

The schema is in `prisma/schema.prisma` (Prisma 7 with the `pg` driver adapter; connection settings in `prisma.config.ts`).

```bash
npm run db:migrate          # apply migrations (production / CI): prisma migrate deploy
npm run db:migrate:dev      # create a new migration after editing the schema (development)
npm run db:seed             # idempotent seed: topic categories, templates, English voices
npm run db:generate         # regenerate the Prisma client (also runs on npm install)
```

Main models: `User`, `Session`, `Project`, `Channel`, `Topic`, `ResearchReference`, `ResearchClaim`, `Script`, `ScriptVersion`, `Voiceover`, `MediaAsset`, `VideoScene`, `Subtitle`, `MusicTrack`, `Video`, `GenerationJob`, `YouTubeAccount`, `PublishJob`, `Schedule`, `AnalyticsSnapshot`, `PerformanceInsight`, `SystemLog`, `AppSetting`, `GenerationTemplate`, `TopicCategory`, `VoicePreset`, `ApiCache`. All primary keys are UUIDs, with indexes, foreign keys and cascading rules.

## Redis and background jobs

BullMQ queues:

| Queue | Jobs |
|---|---|
| `pipeline` | `generate-topic`, `research-topic`, `generate-script`, `validate-script`, `generate-voice`, `plan-visuals`, `search-footage`, `select-footage`, `generate-subtitles`, `select-music`, `generate-metadata`, `content-qa` |
| `render` | `render-video`, `quality-check`, `generate-thumbnail` |
| `publish` | `youtube-upload`, `youtube-publish` |
| `maintenance` | `scheduler-tick` (every minute), `collect-analytics` (6 h), `reconcile` (5 min), `cleanup` (daily) |

Each step runs with 3 retries (5 for uploads), exponential backoff, a timeout, cancellation, progress reporting, structured logs and idempotency: a job that already completed is never re-run. Non-retryable errors, such as a missing credential or a policy violation, fail immediately.

**Recovery:** a job that was running when a worker died is re-queued by BullMQ's stalled-job detection. The `reconcile` job, which also runs at worker start-up, re-queues database-recorded steps whose Redis job disappeared and resumes stuck videos from the first incomplete step. Run Redis with AOF persistence (`--appendonly yes`, as in `docker-compose.yml`) so queued jobs survive restarts.

## FFmpeg

Install FFmpeg 6 with libx264, libass and freetype:

- Ubuntu/Debian: `sudo apt install ffmpeg fonts-dejavu-core`
- macOS: `brew install ffmpeg` (set `FONTS_DIR=/System/Library/Fonts` or install DejaVu)
- Docker: included in the image (Ubuntu 24.04, FFmpeg 6.1)

The render engine (`src/services/video/render-engine.ts`):
- Crops each clip to 9:16 at 1080×1920 and 30 fps, panning slowly across landscape footage and adding a subtle zoom in or out.
- Colour-grades per template and joins clips with transitions (xfade) or cuts.
- Burns in ASS subtitles.
- Normalises the voice (loudnorm) and sets music to about 8-15% with sidechain ducking under the voice, placing sound effects sparingly.
- Limits and normalises the final mix to −14 LUFS.
- Exports H.264 High / yuv420p / AAC 48 kHz with `+faststart`.

## Using the app

| Page | What you can do |
|---|---|
| **Dashboard** | Counts (generated, published, scheduled, failed, processing), next scheduled run and publish, usage and cost, recent videos and jobs |
| **Generate** | Topic or *Generate topic automatically* / *Suggest a topic now*, category, duration (15/30/45/60 or custom), English voice, style (Fast Viral / Cinematic / Minimal), music, privacy, auto-upload |
| **Videos** | Library with thumbnail, title, duration, status, date, YouTube status; filters |
| **Video detail** | Native MP4 preview, live progress (Server-Sent Events) and logs, cancel / retry / publish / regenerate (entire video, script, voice, visuals, footage, subtitles, music, render, metadata, thumbnail), edit metadata, edit script, change voice or music, scene editor with footage replacement, research sources, QC report, delete |
| **Topics** | Topic history (used for deduplication), add or disable categories |
| **Schedules** | AUTO MODE: days, times, time zone, videos per run, rotating categories, voice, style, duration, privacy, auto-publish; run now / pause / edit |
| **YouTube** | Connect / reconnect / disconnect channels, default channel |
| **Analytics** | Views, likes, comments, watch time, average percentage viewed, subscriber changes, and insights by category, hook style, duration, template and publish hour |
| **Settings** | Defaults, subtitle style, publishing, daily and monthly limits and budget, AI model and effort, TTS model, speech-to-text provider, words per minute, music volume, research, SFX; integration status, voice sync, music library upload |
| **Logs** | Structured events with level filter |

**Music:** the library accepts only tracks you have rights to (a license field is mandatory). When no library track matches the mood, Shorts Factory synthesises a royalty-free music bed with FFmpeg, so every video has legal music.

## Testing

```bash
npm test                  # unit + integration tests
npm run test:unit
npm run test:integration  # needs PostgreSQL, Redis and FFmpeg
npm run test:e2e          # Playwright; start the app + worker first
```

- **Unit tests:** English language validation (Estonian, Latvian, Russian, German, Finnish and Spanish are rejected; English prose with proper nouns is accepted), script duration and QC, topic scoring and deduplication, content policy, research sufficiency, metadata limits, subtitle alignment, cues and ASS rendering, scene segmentation, the render filter graph, QC log parsing, footage ranking, scheduler time zones, OAuth state, encryption, and provider request shapes (ElevenLabs, Whisper, Pexels, Claude) with the network mocked.
- **Integration tests:** real PostgreSQL, BullMQ/Redis workers and FFmpeg rendering, with test doubles only for the paid external APIs:
  - the full pipeline from topic to a 1080×1920 MP4 that passes QC, uploaded once as PRIVATE to a fake YouTube client
  - resume after a failure without repeating earlier steps
  - rejection of non-English script output with automatic revision
  - crash recovery
  - auth, limits, scheduler, YouTube token encryption and manual-edit English gates
- Test doubles live in `tests/helpers/fakes.ts` and are never used by production code.
- **Real end-to-end validation** with the real APIs (costs a few cents to a dollar):

  ```bash
  npm run e2e:real -- --email you@example.com                # real script, voice, footage, subtitles, MP4
  npm run e2e:real -- --email you@example.com --upload       # ...and upload as PRIVATE
  ```

  It prints the script, voiceover duration, number of visual assets, subtitle cues, render probe (1080×1920, audio), metadata, the English validation result and the YouTube URL. It never publishes publicly.

The test database defaults to `postgresql://shorts:shorts@localhost:5432/shorts_factory_test`; override it with `TEST_DATABASE_URL` / `TEST_REDIS_URL`.

## Production deployment

- Build one image (`docker build -t shorts-factory .`) and run it three ways: `migrate` (one-shot on each deploy), `web` (scale horizontally behind a load balancer) and `worker` (scale by queue load; rendering is CPU-bound, so set `RENDER_CONCURRENCY` to about CPU cores / 2).
- Use `STORAGE_DRIVER=s3` when the web and worker containers do not share a disk. The browser then receives short-lived pre-signed URLs.
- Serve over HTTPS and set `APP_URL=https://…`. Session cookies become `Secure`, `HttpOnly` and `SameSite=Lax`, and mutating API requests are checked against the `Origin` header.
- Managed Postgres and Redis work (Redis must use `maxmemory-policy noeviction` and persistence).
- `/api/health` checks database and Redis connectivity.
- Logs are JSON on stdout (pino) with secrets redacted. Pipeline events are also stored in `SystemLog` for the UI.

## Architecture

```
src/
  app/                    Next.js App Router: pages ((app)/, (auth)/) and API routes (api/)
  components/             UI (Tailwind): primitives, layout, forms, video editors, live progress
  config/                 env (Zod-validated), templates & subtitle styles, catalog seeds, pricing
  lib/                    db (Prisma), redis, http (retry/backoff/timeouts), errors, logger, crypto, auth, api helpers
  queues/                 BullMQ queue definitions
  jobs/                   step runner, handler registry, per-step handlers (content, media, render, publish)
  worker/                 worker process + maintenance jobs (scheduler, analytics, recovery, cleanup)
  services/
    ai/                   AIProvider interface + AnthropicProvider (structured outputs, web search)
    topics/ research/     topic engine (scoring, dedup) · research with sources and claim types
    scripts/ language/    ScriptService (structure, duration, QC, revision) · LanguageService (English-only)
    tts/                  TTSProvider / SpeechToTextProvider (ElevenLabs, Whisper), voiceover, alignment
    footage/              VideoProvider (Pexels), scene planner, ranking/selection/fallbacks
    subtitles/ music/     cues + ASS styles · music library, procedural music & SFX
    video/ quality/       FFmpeg wrapper + render engine · quality control
    thumbnail/ metadata/  thumbnail composition · title/description/hashtags
    youtube/ publishing/  YouTubeProvider (Data + Analytics API) · scheduler (auto mode)
    analytics/            snapshots + performance insights
    pipeline/             step definitions, orchestrator (resume/regenerate/cancel), recovery
    storage/              StorageProvider: local filesystem, S3-compatible
    settings/ cost/ ...   per-user settings, limits & budget, dedup, policy, cache, logging
prisma/                   schema, migrations, seed
tests/                    unit, integration, e2e (Playwright), helpers (test doubles)
docker/                   entrypoint
docs/                     service documentation
```

Design principles:
- **Resumable pipeline.** `GenerationJob` rows are the source of truth, and a step counts as done when a COMPLETED job exists. Regenerating a component marks it and its dependants SUPERSEDED, and only they re-run (`dependentSteps` in `src/services/pipeline/steps.ts`).
- **Provider abstractions.** `AIProvider`, `TTSProvider`, `SpeechToTextProvider`, `VideoProvider`, `MusicProvider`, `StorageProvider` and `YouTubeProvider` let any provider be swapped.
- **No hard-coded business data.** Categories, voices, templates, durations, limits, providers, models and publishing times live in the database or settings.
- **Security.** Argon2id passwords, hashed session tokens, encrypted OAuth tokens, Zod validation on every input, rate limiting, origin checks, per-user authorisation on every query and media file, and no secrets in logs.

See [`docs/SERVICES.md`](docs/SERVICES.md) for each service's purpose, inputs, outputs, errors, provider, configuration and example usage.

## Troubleshooting

| Symptom | Fix |
|---|---|
| A video stays in its first state | The worker is not running: start `npm run worker` or check `docker compose logs worker`. |
| `Missing credential: set the X environment variable` | Add the key to `.env` and restart the app and the worker. |
| Step fails with `Script failed quality control after 3 attempts` | Open the video: the script panel shows the issues. Adjust the duration or edit the script by hand, then click **Retry**. |
| `Research could not verify` / the topic changed | Automatic topics that cannot be researched reliably are replaced by a new topic (up to 2 times). |
| FFmpeg errors about `ass` or fonts | Install FFmpeg with libass, and set `FONTS_DIR` to a directory that contains DejaVu fonts. |
| YouTube `quotaExceeded` | The daily API quota is used up; uploads retry automatically with backoff. Request more quota from Google. |
| YouTube connection returns no refresh token | Remove the app in your Google account's *Third-party access* and connect again. |
| Uploaded videos are always private | The Google project is unverified; complete the YouTube API audit. |
| Thumbnail warning after upload | The channel needs phone verification for custom thumbnails. |
| `Daily generation limit reached` | Raise the limits in **Settings → Cost control**. |
| Queue jobs lost after a Redis restart | Enable Redis AOF persistence; the reconciler re-queues work recorded in the database. |
