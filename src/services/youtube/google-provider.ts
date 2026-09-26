import { youtube, type youtube_v3 } from "@googleapis/youtube";
import { youtubeAnalytics } from "@googleapis/youtubeanalytics";
import { OAuth2Client } from "google-auth-library";
import { Readable } from "node:stream";
import { AuthenticationError, ExternalServiceError, RateLimitError } from "@/lib/errors";
import {
  YOUTUBE_SCOPES,
  type ChannelInfo,
  type OAuthTokens,
  type RecentUpload,
  type UploadedVideo,
  type UploadRequest,
  type VideoAnalytics,
  type VideoStatistics,
  type VideoStatusInfo,
  type YouTubeClient,
  type YouTubeProvider,
} from "./types";

/**
 * GoogleYouTubeProvider - YouTube Data API v3 + YouTube Analytics API v2 over OAuth 2.0.
 *
 * Configuration: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI
 * (a Google Cloud OAuth client of type "Web application"; the redirect URI must be
 * registered exactly, e.g. https://your-host/api/youtube/callback).
 * The user's Google password is never seen by this application.
 */
const PROVIDER = "youtube";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function mapGoogleError(error: unknown, operation: string): Error {
  const err = error as { code?: number | string; status?: number; message?: string; errors?: { reason?: string }[]; response?: { status?: number; data?: { error?: string | { errors?: { reason?: string }[] } } } };
  const status = Number(err.status ?? err.response?.status ?? err.code) || undefined;
  const data = err.response?.data?.error;
  const reason = err.errors?.[0]?.reason ?? (typeof data === "object" ? data?.errors?.[0]?.reason : typeof data === "string" ? data : undefined);
  if (reason === "invalid_grant") return new AuthenticationError("YouTube authorization expired or was revoked. Reconnect the channel.");
  if (status === 429 || reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") return new RateLimitError(PROVIDER);
  if (reason === "quotaExceeded") {
    return new ExternalServiceError(PROVIDER, `${operation}: daily YouTube API quota exceeded`, { httpStatus: status, retryable: true });
  }
  if (reason === "uploadLimitExceeded") {
    return new ExternalServiceError(PROVIDER, `${operation}: the channel's upload limit was reached`, { httpStatus: status, retryable: false });
  }
  const retryable = !status || status >= 500;
  return new ExternalServiceError(PROVIDER, `${operation} failed: ${err.message ?? String(error)}${reason ? ` (${reason})` : ""}`, {
    httpStatus: status,
    retryable,
    cause: error,
  });
}

function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

class GoogleYouTubeClient implements YouTubeClient {
  private readonly api: youtube_v3.Youtube;
  private readonly analytics: ReturnType<typeof youtubeAnalytics>;

  constructor(auth: OAuth2Client) {
    this.api = youtube({ version: "v3", auth });
    this.analytics = youtubeAnalytics({ version: "v2", auth });
  }

  async getChannel(): Promise<ChannelInfo> {
    try {
      const res = await this.api.channels.list({ part: ["snippet"], mine: true });
      const channel = res.data.items?.[0];
      if (!channel?.id) throw new ExternalServiceError(PROVIDER, "this Google account has no YouTube channel", { retryable: false });
      return {
        channelId: channel.id,
        title: channel.snippet?.title ?? "YouTube channel",
        thumbnailUrl: channel.snippet?.thumbnails?.default?.url ?? undefined,
      };
    } catch (error) {
      if (error instanceof ExternalServiceError) throw error;
      throw mapGoogleError(error, "channels.list");
    }
  }

  async upload(request: UploadRequest): Promise<UploadedVideo> {
    const status: youtube_v3.Schema$VideoStatus = {
      privacyStatus: request.privacyStatus,
      selfDeclaredMadeForKids: false,
      embeddable: true,
      containsSyntheticMedia: request.containsSyntheticMedia,
    };
    if (request.publishAt) {
      status.privacyStatus = "private";
      status.publishAt = request.publishAt.toISOString();
    }
    try {
      const res = await this.api.videos.insert(
        {
          part: ["snippet", "status"],
          notifySubscribers: true,
          requestBody: {
            snippet: {
              title: request.title,
              description: request.description,
              tags: request.tags,
              categoryId: request.categoryId,
              defaultLanguage: "en",
              defaultAudioLanguage: "en",
            },
            status,
          },
          media: { mimeType: "video/mp4", body: request.media },
        },
        {
          onUploadProgress: (event: { bytesRead?: number }) => {
            if (request.mediaSizeBytes && event.bytesRead) request.onProgress?.(Math.min(1, event.bytesRead / request.mediaSizeBytes));
          },
        },
      );
      if (!res.data.id) throw new ExternalServiceError(PROVIDER, "upload response did not include a video id", { retryable: true });
      return {
        videoId: res.data.id,
        privacyStatus: res.data.status?.privacyStatus ?? request.privacyStatus,
        publishAt: res.data.status?.publishAt ?? null,
        uploadStatus: res.data.status?.uploadStatus ?? null,
      };
    } catch (error) {
      if (error instanceof ExternalServiceError) throw error;
      throw mapGoogleError(error, "videos.insert");
    }
  }

  async setThumbnail(videoId: string, image: Buffer, mimeType: string): Promise<void> {
    try {
      await this.api.thumbnails.set({ videoId, media: { mimeType, body: Readable.from(image) } });
    } catch (error) {
      throw mapGoogleError(error, "thumbnails.set");
    }
  }

  async getVideoStatus(videoId: string): Promise<VideoStatusInfo | null> {
    try {
      const res = await this.api.videos.list({ part: ["status", "snippet"], id: [videoId] });
      const item = res.data.items?.[0];
      if (!item) return null;
      return {
        videoId,
        privacyStatus: item.status?.privacyStatus ?? null,
        uploadStatus: item.status?.uploadStatus ?? null,
        publishAt: item.status?.publishAt ?? null,
        failureReason: item.status?.failureReason ?? null,
        rejectionReason: item.status?.rejectionReason ?? null,
        publishedAt: item.snippet?.publishedAt ?? null,
      };
    } catch (error) {
      throw mapGoogleError(error, "videos.list");
    }
  }

  async updatePrivacy(videoId: string, privacyStatus: "private" | "unlisted" | "public", publishAt?: Date | null): Promise<void> {
    try {
      await this.api.videos.update({
        part: ["status"],
        requestBody: {
          id: videoId,
          status: {
            privacyStatus: publishAt ? "private" : privacyStatus,
            publishAt: publishAt ? publishAt.toISOString() : null,
            selfDeclaredMadeForKids: false,
          },
        },
      });
    } catch (error) {
      throw mapGoogleError(error, "videos.update");
    }
  }

  async getStatistics(videoIds: string[]): Promise<Map<string, VideoStatistics>> {
    const result = new Map<string, VideoStatistics>();
    for (let i = 0; i < videoIds.length; i += 50) {
      try {
        const res = await this.api.videos.list({ part: ["statistics"], id: videoIds.slice(i, i + 50) });
        for (const item of res.data.items ?? []) {
          if (!item.id) continue;
          result.set(item.id, {
            views: num(item.statistics?.viewCount),
            likes: num(item.statistics?.likeCount),
            comments: num(item.statistics?.commentCount),
          });
        }
      } catch (error) {
        throw mapGoogleError(error, "videos.list(statistics)");
      }
    }
    return result;
  }

  async getAnalytics(videoId: string, startDate: string, endDate: string): Promise<VideoAnalytics | null> {
    try {
      const res = await this.analytics.reports.query({
        ids: "channel==MINE",
        startDate,
        endDate,
        metrics: "views,likes,comments,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost",
        filters: `video==${videoId}`,
      });
      const headers = (res.data.columnHeaders ?? []).map((h) => h.name ?? "");
      const row = res.data.rows?.[0];
      if (!row) return null;
      const value = (name: string) => num(row[headers.indexOf(name)] as number | string | undefined);
      return {
        views: value("views"),
        likes: value("likes"),
        comments: value("comments"),
        estimatedMinutesWatched: value("estimatedMinutesWatched"),
        averageViewDuration: value("averageViewDuration"),
        averageViewPercentage: value("averageViewPercentage"),
        subscribersGained: value("subscribersGained"),
        subscribersLost: value("subscribersLost"),
      };
    } catch (error) {
      throw mapGoogleError(error, "reports.query");
    }
  }

  async listRecentUploads(limit: number): Promise<RecentUpload[]> {
    try {
      const channel = await this.api.channels.list({ part: ["contentDetails"], mine: true });
      const playlistId = channel.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!playlistId) return [];
      const res = await this.api.playlistItems.list({ part: ["snippet", "contentDetails"], playlistId, maxResults: Math.min(50, limit) });
      return (res.data.items ?? [])
        .map((item) => ({
          videoId: item.contentDetails?.videoId ?? "",
          title: item.snippet?.title ?? "",
          publishedAt: item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt ?? null,
        }))
        .filter((item) => item.videoId);
    } catch (error) {
      throw mapGoogleError(error, "playlistItems.list");
    }
  }
}

export class GoogleYouTubeProvider implements YouTubeProvider {
  constructor(private readonly config: GoogleOAuthConfig) {}

  private oauthClient(): OAuth2Client {
    return new OAuth2Client({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      redirectUri: this.config.redirectUri,
    });
  }

  authorizationUrl(state: string): string {
    return this.oauthClient().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      scope: YOUTUBE_SCOPES,
      state,
    });
  }

  async exchangeCode(code: string): Promise<OAuthTokens> {
    try {
      const { tokens } = await this.oauthClient().getToken(code);
      if (!tokens.access_token) throw new ExternalServiceError(PROVIDER, "no access token returned", { retryable: false });
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        scopes: tokens.scope ? tokens.scope.split(" ") : YOUTUBE_SCOPES,
      };
    } catch (error) {
      if (error instanceof ExternalServiceError) throw error;
      throw mapGoogleError(error, "oauth token exchange");
    }
  }

  client(tokens: OAuthTokens, onTokens: (tokens: Partial<OAuthTokens>) => Promise<void>): YouTubeClient {
    const auth = this.oauthClient();
    auth.setCredentials({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken ?? undefined,
      expiry_date: tokens.expiresAt?.getTime(),
    });
    auth.on("tokens", (fresh) => {
      void onTokens({
        accessToken: fresh.access_token ?? undefined,
        refreshToken: fresh.refresh_token ?? undefined,
        expiresAt: fresh.expiry_date ? new Date(fresh.expiry_date) : undefined,
      });
    });
    return new GoogleYouTubeClient(auth);
  }
}
