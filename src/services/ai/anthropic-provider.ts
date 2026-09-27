import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { estimateAiCost, WEB_SEARCH_COST_PER_SEARCH } from "@/config/pricing";
import {
  AppError,
  CancelledError,
  ContentPolicyError,
  ExternalServiceError,
  RateLimitError,
} from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import type {
  AIProvider,
  AIUsage,
  ResearchRequest,
  ResearchResult,
  StructuredRequest,
  StructuredResult,
  WebSource,
} from "./types";

/**
 * AnthropicProvider: Claude via the official Anthropic TypeScript SDK.
 *
 * - Structured outputs (`output_config.format`) validated with Zod.
 * - Adaptive thinking with configurable effort.
 * - Server-side refusal fallbacks (`fallbacks: "default"`) on models that support it.
 * - Live research through the server-side web search tool.
 * - SDK errors are mapped onto the application's structured error types.
 *
 * Configuration: ANTHROPIC_API_KEY (required), model from user settings.
 */
const PROVIDER = "anthropic";
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const log = createLogger({ module: "ai.anthropic" });

/**
 * Claude models this provider can drive: they must support adaptive thinking and the
 * web_search_20260209 tool (Haiku 4.5 supports neither).
 */
export const CLAUDE_TEXT_MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1"] as const;

function supportsServerFallbacks(model: string): boolean {
  return /^claude-(opus-5|fable-5)/.test(model);
}

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  client?: Anthropic;
}

export class AnthropicProvider implements AIProvider {
  readonly name = PROVIDER;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 3, timeout: REQUEST_TIMEOUT_MS });
  }

  private fallbackParams(): { betas: string[]; fallbacks?: "default" } {
    return supportsServerFallbacks(this.model) ? { betas: [FALLBACK_BETA], fallbacks: "default" } : { betas: [] };
  }

  private usageFrom(usage: Anthropic.Beta.BetaUsage | undefined, model: string): AIUsage {
    const inputTokens =
      (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
    const outputTokens = usage?.output_tokens ?? 0;
    const webSearches = usage?.server_tool_use?.web_search_requests ?? 0;
    return {
      inputTokens,
      outputTokens,
      webSearches,
      model,
      costUsd: estimateAiCost(model, inputTokens, outputTokens) + webSearches * WEB_SEARCH_COST_PER_SEARCH,
    };
  }

  async generateStructured<S extends z.ZodType>(request: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>> {
    const started = Date.now();
    try {
      const response = await this.client.beta.messages.parse(
        {
          model: this.model,
          max_tokens: request.maxTokens ?? 16_000,
          system: request.system,
          messages: [{ role: "user", content: request.prompt }],
          thinking: { type: "adaptive" },
          output_config: { effort: request.effort ?? "medium", format: betaZodOutputFormat(request.schema) },
          ...this.fallbackParams(),
        },
        { signal: request.signal, timeout: REQUEST_TIMEOUT_MS },
      );
      if (response.stop_reason === "refusal") {
        throw new ContentPolicyError("The AI model declined this request", {
          category: response.stop_details?.category ?? null,
        });
      }
      if (response.stop_reason === "max_tokens") {
        throw new ExternalServiceError(PROVIDER, "response was truncated (max_tokens)", { retryable: true });
      }
      const parsed = response.parsed_output;
      if (parsed === null || parsed === undefined) {
        throw new ExternalServiceError(PROVIDER, "structured output could not be parsed", { retryable: true });
      }
      const usage = this.usageFrom(response.usage, response.model ?? this.model);
      log.info({ purpose: request.purpose, ms: Date.now() - started, ...usage }, "structured generation complete");
      return { data: parsed as z.infer<S>, usage };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async researchWithWebSearch(request: ResearchRequest): Promise<ResearchResult> {
    const tool: Anthropic.Beta.BetaWebSearchTool20260209 = {
      type: "web_search_20260209",
      name: "web_search",
      max_uses: request.maxSearches ?? 5,
      ...(request.allowedDomains?.length ? { allowed_domains: request.allowedDomains } : {}),
      ...(!request.allowedDomains?.length && request.blockedDomains?.length
        ? { blocked_domains: request.blockedDomains }
        : {}),
    };
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: request.prompt }];
    const sources = new Map<string, WebSource>();
    const texts: string[] = [];
    const totals: AIUsage = { inputTokens: 0, outputTokens: 0, webSearches: 0, costUsd: 0, model: this.model };

    try {
      // Server tools may pause long turns; continue up to a few times.
      for (let turn = 0; turn < 4; turn++) {
        const response = await this.client.beta.messages.create(
          {
            model: this.model,
            max_tokens: 16_000,
            system: request.system,
            messages,
            tools: [tool],
            thinking: { type: "adaptive" },
            output_config: { effort: "medium" },
            ...this.fallbackParams(),
          },
          { signal: request.signal, timeout: REQUEST_TIMEOUT_MS },
        );
        const usage = this.usageFrom(response.usage, response.model ?? this.model);
        totals.inputTokens += usage.inputTokens;
        totals.outputTokens += usage.outputTokens;
        totals.webSearches += usage.webSearches;
        totals.costUsd += usage.costUsd;

        for (const block of response.content) {
          if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
            for (const result of block.content) {
              if (!sources.has(result.url)) {
                sources.set(result.url, { url: result.url, title: result.title, pageAge: result.page_age });
              }
            }
          } else if (block.type === "text") {
            texts.push(block.text);
            for (const citation of block.citations ?? []) {
              if (citation.type === "web_search_result_location") {
                const existing = sources.get(citation.url);
                sources.set(citation.url, {
                  url: citation.url,
                  title: citation.title ?? existing?.title ?? citation.url,
                  pageAge: existing?.pageAge,
                  citedText: existing?.citedText ?? citation.cited_text,
                });
              }
            }
          }
        }

        if (response.stop_reason === "refusal") {
          throw new ContentPolicyError("The AI model declined this research request");
        }
        if (response.stop_reason !== "pause_turn") break;
        messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
      }
    } catch (error) {
      throw this.mapError(error);
    }

    return { notes: texts.join("").trim(), sources: [...sources.values()], usage: totals };
  }

  private mapError(error: unknown): Error {
    if (error instanceof AppError) return error;
    if (error instanceof Anthropic.APIUserAbortError) return new CancelledError();
    if (error instanceof Anthropic.RateLimitError) {
      const retryAfter = Number(error.headers?.get?.("retry-after"));
      return new RateLimitError(PROVIDER, Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
    }
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      return new ExternalServiceError(PROVIDER, "authentication failed - check ANTHROPIC_API_KEY", {
        httpStatus: error.status,
        retryable: false,
        cause: error,
      });
    }
    if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError) {
      return new ExternalServiceError(PROVIDER, `request rejected: ${error.message}`, {
        httpStatus: error.status,
        retryable: false,
        cause: error,
      });
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return new ExternalServiceError(PROVIDER, `connection error: ${error.message}`, { retryable: true, cause: error });
    }
    if (error instanceof Anthropic.APIError) {
      return new ExternalServiceError(PROVIDER, error.message, {
        httpStatus: error.status,
        retryable: (error.status ?? 500) >= 500,
        cause: error,
      });
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
