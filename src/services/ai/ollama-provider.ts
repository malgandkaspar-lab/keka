import { z } from "zod";
import { AppError, ExternalServiceError } from "@/lib/errors";
import { request } from "@/lib/http";
import { createLogger } from "@/lib/logger";
import { researchOnWikipedia } from "@/services/research/wikipedia";
import type { AIProvider, AIUsage, ResearchRequest, ResearchResult, StructuredRequest, StructuredResult } from "./types";

/**
 * OllamaProvider - free local AI (no API key, no per-token cost).
 *
 * Runs an open model (default qwen2.5:7b) through a local Ollama server. Structured
 * output uses Ollama's JSON-schema `format`, and every response is validated with Zod;
 * invalid JSON is sent back to the model with the validation errors (up to 2 repairs).
 * Research uses the free Wikipedia API instead of paid web search.
 *
 * Configuration: OLLAMA_BASE_URL (default http://localhost:11434) and the model in
 * Settings (or OLLAMA_MODEL). Setup: install Ollama, then `ollama pull qwen2.5:7b`.
 */
const PROVIDER = "ollama";
const log = createLogger({ module: "ai.ollama" });

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const chatResponseSchema = z.object({
  message: z.object({ content: z.string() }),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
  done_reason: z.string().optional(),
});

export class OllamaProvider implements AIProvider {
  readonly name = PROVIDER;
  readonly prefersSimpleOutput = true;

  constructor(
    readonly model: string,
    private readonly baseUrl: string,
  ) {}

  private async chat(messages: ChatMessage[], format: unknown, signal?: AbortSignal) {
    let res: Response;
    try {
      res = await request(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
        provider: PROVIDER,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          format,
          stream: false,
          keep_alive: "15m",
          options: { temperature: 0.5, num_ctx: 16384 },
        }),
        timeoutMs: 15 * 60_000,
        retries: 2,
        baseDelayMs: 2000,
        signal,
      });
    } catch (error) {
      throw this.explain(error);
    }
    const parsed = chatResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new ExternalServiceError(PROVIDER, "unexpected response from Ollama", { retryable: true });
    return parsed.data;
  }

  private explain(error: unknown): Error {
    if (error instanceof ExternalServiceError) {
      if (error.httpStatus === 404) {
        return new ExternalServiceError(PROVIDER, `model "${this.model}" is not installed. Run: ollama pull ${this.model}`, { httpStatus: 404, retryable: false });
      }
      if (error.message.includes("network error")) {
        return new ExternalServiceError(PROVIDER, `Ollama is not reachable at ${this.baseUrl}. Install it from https://ollama.com and start it (ollama serve).`, { retryable: true, cause: error });
      }
    }
    return error instanceof AppError || error instanceof Error ? error : new Error(String(error));
  }

  async generateStructured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>> {
    const jsonSchema = z.toJSONSchema(req.schema);
    const messages: ChatMessage[] = [
      { role: "system", content: `${req.system}\n\nRespond with a single JSON object that matches the requested schema exactly. Do not add any other text.` },
      { role: "user", content: req.prompt },
    ];
    const usage: AIUsage = { inputTokens: 0, outputTokens: 0, webSearches: 0, costUsd: 0, model: this.model };
    let lastIssue = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await this.chat(messages, jsonSchema, req.signal);
      usage.inputTokens += response.prompt_eval_count ?? 0;
      usage.outputTokens += response.eval_count ?? 0;
      let json: unknown;
      try {
        json = JSON.parse(response.message.content);
      } catch {
        lastIssue = "The response was not valid JSON.";
      }
      if (json !== undefined) {
        const result = req.schema.safeParse(json);
        if (result.success) {
          log.info({ purpose: req.purpose, attempt, ...usage }, "local structured generation complete");
          return { data: result.data, usage };
        }
        lastIssue = result.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      }
      messages.push({ role: "assistant", content: response.message.content.slice(0, 20_000) }, { role: "user", content: `That JSON is invalid: ${lastIssue}. Return the corrected JSON object only.` });
    }
    throw new ExternalServiceError(PROVIDER, `the model did not return valid structured output (${lastIssue})`, { retryable: true });
  }

  async researchWithWebSearch(req: ResearchRequest): Promise<ResearchResult> {
    const planned = await this.generateStructured({
      purpose: "research.queries",
      system: "You plan encyclopedia searches. Write short English search queries.",
      prompt: `${req.prompt}\n\nGive 3 short English Wikipedia search queries (2-5 words each) that would find the key facts.`,
      schema: z.object({ queries: z.array(z.string()) }),
      signal: req.signal,
    });
    const queries = [...new Set(planned.data.queries.map((q) => q.trim()).filter(Boolean))].slice(0, 4);
    const pages = await researchOnWikipedia(queries.length ? queries : [req.prompt.slice(0, 80)], req.maxSearches ?? 4, req.signal);
    const notes = pages.map((p) => `SOURCE: ${p.title} (${p.url})\n${p.text}`).join("\n\n---\n\n");
    return {
      notes,
      sources: pages.map(({ text: _text, ...source }) => source),
      usage: { ...planned.usage, webSearches: queries.length },
    };
  }
}
