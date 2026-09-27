import type { PrivacyStatus, YouTubeAccount } from "@/generated/prisma/client";
import { getEnv, requireCredential } from "@/config/env";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret, hmacSha256, randomToken, safeEqual } from "@/lib/crypto";
import { AuthenticationError, ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { GoogleYouTubeProvider } from "./google-provider";
import { createLogger } from "@/lib/logger";
import type { OAuthTokens, YouTubeClient, YouTubeProvider } from "./types";

const log = createLogger({ module: "youtube" });

/**
 * YouTubeService
 *
 * Purpose: connect YouTube channels via OAuth 2.0, store tokens encrypted (AES-256-GCM),
 * and provide authorised API clients that transparently persist refreshed tokens.
 * Security: OAuth `state` is HMAC-signed, bound to the user, single-use (nonce cookie)
 * and expires after 10 minutes.
 */
let override: YouTubeProvider | undefined;

export function getYouTubeProvider(): YouTubeProvider {
  if (override) return override;
  return new GoogleYouTubeProvider({
    clientId: requireCredential("YOUTUBE_CLIENT_ID"),
    clientSecret: requireCredential("YOUTUBE_CLIENT_SECRET"),
    redirectUri: requireCredential("YOUTUBE_REDIRECT_URI"),
  });
}

export function setYouTubeProviderForTesting(provider: YouTubeProvider | undefined): void {
  override = provider;
}

const STATE_TTL_MS = 10 * 60 * 1000;

export function createOAuthState(userId: string): { state: string; nonce: string } {
  const nonce = randomToken(16);
  const payload = Buffer.from(JSON.stringify({ u: userId, n: nonce, e: Date.now() + STATE_TTL_MS })).toString("base64url");
  const signature = hmacSha256(payload, getEnv().AUTH_SECRET);
  return { state: `${payload}.${signature}`, nonce };
}

export function verifyOAuthState(state: string, expectedUserId: string, nonceCookie: string | undefined): void {
  const [payload, signature] = state.split(".");
  if (!payload || !signature || !safeEqual(signature, hmacSha256(payload, getEnv().AUTH_SECRET))) {
    throw new AuthenticationError("Invalid OAuth state");
  }
  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u: string; n: string; e: number };
  if (data.e < Date.now()) throw new AuthenticationError("OAuth state expired, please try again");
  if (data.u !== expectedUserId) throw new AuthenticationError("OAuth state does not belong to this user");
  if (!nonceCookie || !safeEqual(nonceCookie, data.n)) throw new AuthenticationError("OAuth state mismatch");
}

export async function connectAccount(userId: string, code: string): Promise<YouTubeAccount> {
  const provider = getYouTubeProvider();
  const tokens = await provider.exchangeCode(code);
  const client = provider.client(tokens, async () => undefined);
  const channel = await client.getChannel();
  const existing = await db.youTubeAccount.findUnique({ where: { userId_googleChannelId: { userId, googleChannelId: channel.channelId } } });
  const accountCount = await db.youTubeAccount.count({ where: { userId } });
  const refreshTokenEnc = tokens.refreshToken ? encryptSecret(tokens.refreshToken) : existing?.refreshTokenEnc ?? null;
  if (!refreshTokenEnc) {
    throw new ValidationError("Google did not return a refresh token. Remove the app's access in your Google account settings and connect again.");
  }
  return db.youTubeAccount.upsert({
    where: { userId_googleChannelId: { userId, googleChannelId: channel.channelId } },
    create: {
      userId,
      googleChannelId: channel.channelId,
      channelTitle: channel.title,
      channelThumbnail: channel.thumbnailUrl ?? null,
      accessTokenEnc: encryptSecret(tokens.accessToken),
      refreshTokenEnc,
      tokenExpiresAt: tokens.expiresAt ?? null,
      scopes: tokens.scopes,
      isDefault: accountCount === 0,
    },
    update: {
      channelTitle: channel.title,
      channelThumbnail: channel.thumbnailUrl ?? null,
      accessTokenEnc: encryptSecret(tokens.accessToken),
      refreshTokenEnc,
      tokenExpiresAt: tokens.expiresAt ?? null,
      scopes: tokens.scopes,
      status: "ACTIVE",
      lastError: null,
    },
  });
}

export function accountTokens(account: YouTubeAccount): OAuthTokens {
  return {
    accessToken: decryptSecret(account.accessTokenEnc),
    refreshToken: account.refreshTokenEnc ? decryptSecret(account.refreshTokenEnc) : null,
    expiresAt: account.tokenExpiresAt,
    scopes: account.scopes,
  };
}

export async function clientForAccount(account: YouTubeAccount): Promise<YouTubeClient> {
  if (account.status === "REVOKED") throw new AuthenticationError(`YouTube channel "${account.channelTitle}" must be reconnected`);
  const provider = getYouTubeProvider();
  return provider.client(accountTokens(account), async (fresh) => {
    await db.youTubeAccount.update({
      where: { id: account.id },
      data: {
        ...(fresh.accessToken ? { accessTokenEnc: encryptSecret(fresh.accessToken) } : {}),
        ...(fresh.refreshToken ? { refreshTokenEnc: encryptSecret(fresh.refreshToken) } : {}),
        ...(fresh.expiresAt ? { tokenExpiresAt: fresh.expiresAt } : {}),
        status: "ACTIVE",
        lastError: null,
      },
    });
  });
}

export async function markAccountError(accountId: string, error: Error): Promise<void> {
  await db.youTubeAccount.update({
    where: { id: accountId },
    data: { status: error instanceof AuthenticationError ? "REVOKED" : "ERROR", lastError: error.message.slice(0, 500) },
  });
}

export async function resolveAccountForVideo(video: { userId: string; youtubeAccountId: string | null; channelId: string | null }): Promise<YouTubeAccount> {
  if (video.youtubeAccountId) {
    const account = await db.youTubeAccount.findFirst({ where: { id: video.youtubeAccountId, userId: video.userId } });
    if (account) return account;
  }
  if (video.channelId) {
    const channel = await db.channel.findUnique({ where: { id: video.channelId }, include: { youtubeAccount: true } });
    if (channel?.youtubeAccount) return channel.youtubeAccount;
  }
  const fallback = await db.youTubeAccount.findFirst({
    where: { userId: video.userId, status: { not: "REVOKED" } },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  if (!fallback) throw new NotFoundError("Connected YouTube channel (connect one on the YouTube page)");
  return fallback;
}

export function privacyForUpload(privacy: PrivacyStatus, scheduledAt: Date | null): { privacyStatus: "private" | "unlisted" | "public"; publishAt: Date | null } {
  if (privacy === "SCHEDULED") {
    if (!scheduledAt) throw new ValidationError("A scheduled publish time is required for SCHEDULED videos");
    if (scheduledAt.getTime() < Date.now() + 5 * 60 * 1000) {
      throw new ValidationError("The scheduled publish time must be at least 5 minutes in the future");
    }
    return { privacyStatus: "private", publishAt: scheduledAt };
  }
  return { privacyStatus: privacy.toLowerCase() as "private" | "unlisted" | "public", publishAt: null };
}

export async function disconnectAccount(userId: string, accountId: string): Promise<void> {
  const account = await db.youTubeAccount.findFirst({ where: { id: accountId, userId } });
  if (!account) throw new NotFoundError("YouTube account", accountId);
  const pending = await db.publishJob.count({ where: { youtubeAccountId: accountId, status: { in: ["PENDING", "UPLOADING"] } } });
  if (pending) throw new ConflictError("This channel has uploads in progress");
  // Revoke the grant at Google too (Google API Services User Data Policy). A token that is
  // already expired or revoked must not block removing the channel from the app.
  const token = account.refreshTokenEnc ?? account.accessTokenEnc;
  try {
    await getYouTubeProvider().revokeToken(decryptSecret(token));
  } catch (error) {
    log.warn({ accountId, err: (error as Error).message }, "could not revoke the Google grant; removing the channel anyway");
  }
  await db.youTubeAccount.delete({ where: { id: accountId } });
}

export function youtubeUrl(videoId: string): string {
  return `https://www.youtube.com/shorts/${videoId}`;
}
