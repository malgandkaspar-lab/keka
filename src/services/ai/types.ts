import type { z } from "zod";

/**
 * AIProvider
 *
 * Purpose: provider-neutral interface for text generation, so Claude can be swapped
 * for another model provider later without touching business logic.
 *
 * - generateStructured: produce JSON validated against a Zod schema.
 * - researchWithWebSearch: answer a research question using live web search and
 *   return the notes plus the sources that were actually consulted.
 */
export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  costUsd: number;
  model: string;
}

export interface StructuredRequest<S extends z.ZodType> {
  system: string;
  prompt: string;
  schema: S;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  signal?: AbortSignal;
  /** Short label for logs, e.g. "script.generate". */
  purpose: string;
}

export interface StructuredResult<T> {
  data: T;
  usage: AIUsage;
}

export interface WebSource {
  url: string;
  title: string;
  pageAge?: string | null;
  citedText?: string;
}

export interface ResearchRequest {
  system: string;
  prompt: string;
  maxSearches?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  signal?: AbortSignal;
}

export interface ResearchResult {
  notes: string;
  sources: WebSource[];
  usage: AIUsage;
}

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  /** Small local model: callers should prefer fewer, simpler structured requests. */
  readonly prefersSimpleOutput?: boolean;
  generateStructured<S extends z.ZodType>(request: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>>;
  researchWithWebSearch(request: ResearchRequest): Promise<ResearchResult>;
}
