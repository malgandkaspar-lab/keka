import type { Readable } from "node:stream";

/**
 * YouTubeProvider
 *
 * Purpose: everything the application needs from YouTube, behind an interface so the
 * Google client can be mocked in tests. Implementation: GoogleYouTubeProvider
 * (YouTube Data API v3 + YouTube Analytics API v2, OAuth 2.0).
 */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  scopes: string[];
}

export interface ChannelInfo {
  channelId: string;
  title: string;
  thumbnailUrl?: string;
}

export interface UploadRequest {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: "private" | "unlisted" | "public";
  publishAt?: Date | null;
  containsSyntheticMedia: boolean;
  media: Readable;
  mediaSizeBytes?: number;
  onProgress?: (fraction: number) => void;
}

export interface UploadedVideo {
  videoId: string;
  privacyStatus: string;
  publishAt?: string | null;
  uploadStatus?: string | null;
}

export interface VideoStatusInfo {
  videoId: string;
  privacyStatus: string | null;
  uploadStatus: string | null;
  publishAt: string | null;
  failureReason: string | null;
  rejectionReason: string | null;
  publishedAt: string | null;
}

export interface VideoStatistics {
  views: number | null;
  likes: number | null;
  comments: number | null;
}

export interface VideoAnalytics {
  views: number | null;
  likes: number | null;
  comments: number | null;
  estimatedMinutesWatched: number | null;
  averageViewDuration: number | null;
  averageViewPercentage: number | null;
  subscribersGained: number | null;
  subscribersLost: number | null;
}

export interface RecentUpload {
  videoId: string;
  title: string;
  publishedAt: string | null;
}

export interface YouTubeClient {
  getChannel(): Promise<ChannelInfo>;
  upload(request: UploadRequest): Promise<UploadedVideo>;
  setThumbnail(videoId: string, image: Buffer, mimeType: string): Promise<void>;
  getVideoStatus(videoId: string): Promise<VideoStatusInfo | null>;
  updatePrivacy(videoId: string, privacyStatus: "private" | "unlisted" | "public", publishAt?: Date | null): Promise<void>;
  getStatistics(videoIds: string[]): Promise<Map<string, VideoStatistics>>;
  getAnalytics(videoId: string, startDate: string, endDate: string): Promise<VideoAnalytics | null>;
  listRecentUploads(limit: number): Promise<RecentUpload[]>;
}

export interface YouTubeProvider {
  authorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<OAuthTokens>;
  /** A client acting on behalf of an account; `onTokens` persists refreshed tokens. */
  client(tokens: OAuthTokens, onTokens: (tokens: Partial<OAuthTokens>) => Promise<void>): YouTubeClient;
  /** Revokes the app's access at Google (the refresh token revokes the whole grant). */
  revokeToken(token: string): Promise<void>;
}

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];
