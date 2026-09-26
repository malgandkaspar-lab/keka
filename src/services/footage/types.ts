/**
 * VideoProvider (stock footage) interface.
 *
 * Purpose: search legitimately licensed stock media by keyword and download it.
 * Implementations: PexelsProvider. Every candidate carries provenance (source URL,
 * author, license) which is stored with the downloaded MediaAsset.
 */
export interface FootageFile {
  url: string;
  width: number;
  height: number;
  fps?: number;
  quality?: string;
}

export interface FootageCandidate {
  provider: string;
  kind: "video" | "image";
  id: string;
  pageUrl: string;
  width: number;
  height: number;
  durationSec: number;
  author: string;
  authorUrl?: string;
  license: string;
  licenseUrl: string;
  previewImage?: string;
  files: FootageFile[];
  query: string;
  rank: number;
}

export interface FootageSearchOptions {
  orientation?: "portrait" | "landscape" | "square";
  perPage?: number;
  page?: number;
  signal?: AbortSignal;
}

export interface VideoProvider {
  readonly name: string;
  searchVideos(query: string, options?: FootageSearchOptions): Promise<FootageCandidate[]>;
  searchImages(query: string, options?: FootageSearchOptions): Promise<FootageCandidate[]>;
  download(url: string, signal?: AbortSignal): Promise<Buffer>;
}
