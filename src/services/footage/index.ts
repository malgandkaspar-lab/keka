import { requireCredential } from "@/config/env";
import { PexelsProvider } from "./pexels";
import type { VideoProvider } from "./types";

let override: VideoProvider | undefined;

/** Stock footage provider factory (Pexels today; add providers behind VideoProvider). */
export function getVideoProvider(): VideoProvider {
  if (override) return override;
  return new PexelsProvider(requireCredential("PEXELS_API_KEY"));
}

export function setVideoProviderForTesting(provider: VideoProvider | undefined): void {
  override = provider;
}

export type { FootageCandidate, VideoProvider } from "./types";
