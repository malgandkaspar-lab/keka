/**
 * TEST DOUBLES ONLY.
 *
 * Deterministic stand-ins for paid external APIs (Claude, ElevenLabs, Pexels, YouTube)
 * so the full pipeline - database, BullMQ queues, FFmpeg rendering, quality control -
 * can be exercised in CI without credentials. Production code never imports this file.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { z } from "zod";
import type { AIProvider, AIUsage, ResearchRequest, ResearchResult, StructuredRequest, StructuredResult } from "@/services/ai/types";
import type { FootageCandidate, FootageSearchOptions, VideoProvider } from "@/services/footage/types";
import type { SpeechToTextProvider, SynthesisRequest, SynthesisResult, TranscriptionResult, TTSProvider, VoiceInfo } from "@/services/tts/types";
import type {
  OAuthTokens,
  RecentUpload,
  UploadedVideo,
  UploadRequest,
  VideoAnalytics,
  VideoStatistics,
  VideoStatusInfo,
  YouTubeClient,
  YouTubeProvider,
} from "@/services/youtube/types";
import { ffmpeg } from "@/services/video/ffmpeg";
import { estimateSpeechDurationSec } from "@/services/scripts/duration";

const usage = (model = "fake-model"): AIUsage => ({ inputTokens: 1000, outputTokens: 500, webSearches: 0, costUsd: 0.01, model });

export const ASTRONAUT_SCRIPT = {
  hookStyle: "unexpected_fact" as const,
  sections: [
    { type: "HOOK" as const, text: "Astronauts come home up to two inches taller." },
    { type: "CURIOSITY" as const, text: "And it happens on almost every long mission to the space station." },
    {
      type: "INFORMATION" as const,
      text: "On Earth, gravity squeezes the soft discs between your vertebrae all day long. In orbit, that pressure disappears, so the discs relax and the spine stretches by about three percent. Back on the ground, gravity slowly squeezes them back within months.",
    },
    { type: "CTA" as const, text: "Would you want to be taller for a few months?" },
  ],
  factsUsed: ["Astronauts can grow up to 3% taller in microgravity"],
};

export class FakeAIProvider implements AIProvider {
  readonly name = "fake-ai";
  readonly model = "fake-model";
  calls: Record<string, number> = {};
  /** Optional override per purpose, returning raw data. */
  overrides: Record<string, (request: StructuredRequest<z.ZodType>) => unknown> = {};

  async generateStructured<S extends z.ZodType>(request: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>> {
    this.calls[request.purpose] = (this.calls[request.purpose] ?? 0) + 1;
    const override = this.overrides[request.purpose];
    const raw = override ? override(request as unknown as StructuredRequest<z.ZodType>) : this.respond(request);
    return { data: request.schema.parse(raw), usage: usage() };
  }

  private respond(request: StructuredRequest<z.ZodType>): unknown {
    switch (request.purpose) {
      case "topic.generate":
        return {
          candidates: [
            {
              title: `Why do octopuses have three hearts? (${Math.random().toString(36).slice(2, 7)})`,
              angle: "Each heart has a different job",
              scores: { curiosity: 9, novelty: 8, educationalValue: 9, entertainment: 8, visualPotential: 8, shortFormPotential: 9, factualVerifiability: 9 },
              visualIdeas: ["octopus underwater"],
            },
          ],
        };
      case "research.extract":
        return {
          summary: "Astronauts grow taller in microgravity because their spinal discs expand without gravity compressing them. The effect reverses after returning to Earth.",
          claims: [
            { statement: "Astronauts can grow up to 3% taller in space", type: "ESTABLISHED_FACT", confidence: 0.95, sourceUrls: ["https://www.nasa.gov/spine"] },
            { statement: "Spinal discs expand in microgravity", type: "ESTABLISHED_FACT", confidence: 0.9, sourceUrls: ["https://www.nasa.gov/spine"] },
            { statement: "Height returns to normal after landing", type: "ESTABLISHED_FACT", confidence: 0.9, sourceUrls: ["https://www.ncbi.nlm.nih.gov/spine"] },
          ],
          sufficient: true,
          recommendedAngle: "Gravity compresses the spine",
          cautions: ["Astronauts do not permanently grow taller"],
        };
      case "research.facts":
        return { facts: [{ statement: "Astronauts grow up to 3 percent taller in microgravity", source: 1 }] };
      case "script.generate":
      case "script.revise":
      case "script.fit":
        return ASTRONAUT_SCRIPT;
      case "script.review":
        return {
          grammarAndSpellingOk: true,
          factuallyConsistent: true,
          unsupportedClaims: [],
          inappropriateContent: false,
          misleadingHook: false,
          singleFact: true,
          hookStatesFact: true,
          hookScore: 8,
          conclusionScore: 8,
          shortsSuitabilityScore: 9,
          issues: [],
        };
      case "visuals.plan": {
        const count = (request.prompt.match(/^\d+: \[/gm) ?? []).length;
        const visuals = ["astronaut floating", "space station orbit", "human spine", "earth from space", "rocket landing"];
        return {
          musicMood: "cinematic",
          scenes: Array.from({ length: count }, (_, index) => ({
            index,
            visualDescription: `Shot of ${visuals[index % visuals.length]}`,
            keywords: [visuals[index % visuals.length]!, "space"],
            fallbackKeywords: ["space", "stars"],
            transition: "fade",
          })),
        };
      }
      case "metadata.generate":
        return {
          title: "Why Astronauts Come Home Taller",
          description: "In space, the discs in your spine are no longer squeezed by gravity, so astronauts grow up to two inches taller. Here is why it happens and why it does not last.",
          hashtags: ["#Space", "#Astronauts", "#ScienceFacts"],
          tags: ["astronauts", "space facts", "spine", "microgravity", "science"],
          thumbnailText: "Taller In Space",
        };
      default:
        throw new Error(`FakeAIProvider: unhandled purpose ${request.purpose}`);
    }
  }

  async researchWithWebSearch(_request: ResearchRequest): Promise<ResearchResult> {
    this.calls["research.search"] = (this.calls["research.search"] ?? 0) + 1;
    return {
      notes: "NASA reports astronauts grow up to 3 percent taller in microgravity as spinal discs expand.",
      sources: [
        { url: "https://www.nasa.gov/spine", title: "NASA: Spinal elongation in microgravity" },
        { url: "https://www.ncbi.nlm.nih.gov/spine", title: "Spinal changes in astronauts" },
      ],
      usage: usage(),
    };
  }
}

/** Generates real (synthetic tone) MP3 audio whose length matches the text. */
export class FakeTTSProvider implements TTSProvider {
  readonly name = "fake-tts";
  readonly settingRanges = { speed: { min: 0.7, max: 1.2, default: 1 } };
  calls = 0;
  failNext = 0;

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    this.calls++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("fake TTS failure");
    }
    const duration = estimateSpeechDurationSec(request.text, 165) / (request.settings.speed ?? 1);
    const dir = await mkdtemp(path.join(os.tmpdir(), "fake-tts-"));
    const out = path.join(dir, "voice.mp3");
    const expr = "0.5*sin(2*PI*(160+40*sin(2*PI*3*t))*t)*(0.6+0.4*sin(2*PI*4*t))";
    await ffmpeg(["-f", "lavfi", "-i", `aevalsrc=exprs='${expr}':s=44100:d=${duration.toFixed(2)}`, "-c:a", "libmp3lame", "-b:a", "96k", out]);
    const audio = await readFile(out);
    await rm(dir, { recursive: true, force: true });
    const characters = [...request.text];
    const per = duration / characters.length;
    return {
      audio,
      mimeType: "audio/mpeg",
      extension: "mp3",
      alignment: { characters, starts: characters.map((_, i) => i * per), ends: characters.map((_, i) => (i + 1) * per) },
      characters: characters.length,
    };
  }

  async listVoices(): Promise<VoiceInfo[]> {
    return [{ voiceId: "fake-voice", name: "Fake", styles: ["calm"], englishCapable: true }];
  }
}

/** Returns the script words with evenly spaced timings. */
export class FakeSTTProvider implements SpeechToTextProvider {
  readonly name = "fake-stt";
  transcriptOverride: string | null = null;
  constructor(private readonly textForAudio: () => string) {}

  async transcribe(): Promise<TranscriptionResult> {
    const text = this.transcriptOverride ?? this.textForAudio();
    const words = text.split(/\s+/).filter(Boolean);
    return { text, language: "en", languageProbability: 0.99, words: words.map((w, i) => ({ text: w, start: i * 0.36, end: i * 0.36 + 0.3 })) };
  }
}

/** Serves FFmpeg-generated test clips instead of Pexels downloads. */
export class FakeVideoProvider implements VideoProvider {
  readonly name = "pexels";
  searches = 0;
  downloads = 0;
  failDownloads = false;

  async searchVideos(query: string, options: FootageSearchOptions = {}): Promise<FootageCandidate[]> {
    this.searches++;
    const base = Math.abs([...query].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7));
    return Array.from({ length: 3 }, (_, i) => {
      const portrait = options.orientation === "portrait" || i % 2 === 0;
      return {
        provider: "pexels",
        kind: "video" as const,
        id: `fake-${base}-${i}`,
        pageUrl: `https://www.pexels.com/video/fake-${base}-${i}/`,
        width: portrait ? 1080 : 1920,
        height: portrait ? 1920 : 1080,
        durationSec: 8,
        author: `Test Author ${i}`,
        license: "Pexels License",
        licenseUrl: "https://www.pexels.com/license/",
        files: [{ url: `https://videos.pexels.com/fake/${base}-${i}.mp4`, width: portrait ? 1080 : 1920, height: portrait ? 1920 : 1080 }],
        query,
        rank: i,
      };
    });
  }

  async searchImages(): Promise<FootageCandidate[]> {
    return [];
  }

  async download(url: string): Promise<Buffer> {
    this.downloads++;
    if (this.failDownloads) throw new Error("fake download failure");
    const portrait = !url.includes("-1.mp4");
    const dir = await mkdtemp(path.join(os.tmpdir(), "fake-clip-"));
    const out = path.join(dir, "clip.mp4");
    const size = portrait ? "1080x1920" : "1920x1080";
    await ffmpeg(["-f", "lavfi", "-i", `testsrc2=s=${size}:r=30:d=8`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out]);
    const data = await readFile(out);
    await rm(dir, { recursive: true, force: true });
    return data;
  }
}

export class FakeYouTubeClient implements YouTubeClient {
  uploads: UploadRequest[] = [];
  thumbnails: string[] = [];
  statuses = new Map<string, VideoStatusInfo>();
  recent: RecentUpload[] = [];
  failUploads = 0;

  async getChannel() {
    return { channelId: "UC_fake_channel", title: "Fake Channel" };
  }
  async upload(request: UploadRequest): Promise<UploadedVideo> {
    for await (const _chunk of request.media) {
      // consume the stream like a real upload
    }
    if (this.failUploads > 0) {
      this.failUploads--;
      throw new Error("fake upload network failure");
    }
    this.uploads.push(request);
    const videoId = `yt_${this.uploads.length}`;
    this.statuses.set(videoId, {
      videoId,
      privacyStatus: request.privacyStatus,
      uploadStatus: "uploaded",
      publishAt: request.publishAt?.toISOString() ?? null,
      failureReason: null,
      rejectionReason: null,
      publishedAt: new Date().toISOString(),
    });
    return { videoId, privacyStatus: request.privacyStatus, publishAt: request.publishAt?.toISOString() ?? null };
  }
  async setThumbnail(videoId: string) {
    this.thumbnails.push(videoId);
  }
  async getVideoStatus(videoId: string) {
    return this.statuses.get(videoId) ?? null;
  }
  async updatePrivacy(videoId: string, privacyStatus: "private" | "unlisted" | "public", publishAt?: Date | null) {
    const status = this.statuses.get(videoId);
    if (status) this.statuses.set(videoId, { ...status, privacyStatus, publishAt: publishAt?.toISOString() ?? null });
  }
  async getStatistics(ids: string[]) {
    return new Map<string, VideoStatistics>(ids.map((id, i) => [id, { views: 100 * (i + 1), likes: 10, comments: 2 }]));
  }
  async getAnalytics(): Promise<VideoAnalytics | null> {
    return { views: 100, likes: 10, comments: 2, estimatedMinutesWatched: 40, averageViewDuration: 21, averageViewPercentage: 72, subscribersGained: 3, subscribersLost: 0 };
  }
  async listRecentUploads(): Promise<RecentUpload[]> {
    return this.recent;
  }
}

export class FakeYouTubeProvider implements YouTubeProvider {
  readonly client_ = new FakeYouTubeClient();
  authorizationUrl(state: string) {
    return `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(state)}`;
  }
  async exchangeCode(): Promise<OAuthTokens> {
    return { accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: new Date(Date.now() + 3600_000), scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/yt-analytics.readonly"] };
  }
  client(): YouTubeClient {
    return this.client_;
  }
  revoked: string[] = [];
  async revokeToken(token: string): Promise<void> {
    this.revoked.push(token);
  }
}

export function streamOf(buffer: Buffer): Readable {
  return Readable.from(buffer);
}
