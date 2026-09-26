import { z } from "zod";
import { getEnv } from "@/config/env";
import { requestJson } from "@/lib/http";
import type { WebSource } from "@/services/ai/types";

/**
 * Free research source: the English Wikipedia (MediaWiki Action API, no key, no cost).
 * Used by the local (Ollama) AI provider in place of paid web search.
 * Content is CC BY-SA; only short excerpts are used as research notes and every page
 * is stored as a reference with its URL.
 */
const API = "https://en.wikipedia.org/w/api.php";
const MAX_CHARS_PER_PAGE = 3500;

const searchSchema = z.object({
  query: z.object({ search: z.array(z.object({ title: z.string(), pageid: z.number() })) }).optional(),
});

const extractSchema = z.object({
  query: z.object({
    pages: z.record(z.string(), z.object({ title: z.string(), extract: z.string().optional(), fullurl: z.string().optional() })),
  }),
});

function headers(): Record<string, string> {
  return { "user-agent": `ShortsFactory/1.0 (${getEnv().APP_URL}; research for educational videos)`, "api-user-agent": "ShortsFactory/1.0" };
}

export async function searchWikipedia(query: string, limit = 4, signal?: AbortSignal): Promise<{ title: string; pageid: number }[]> {
  const params = new URLSearchParams({ action: "query", list: "search", srsearch: query, srlimit: String(limit), format: "json", origin: "*" });
  const res = await requestJson<unknown>(`${API}?${params}`, { provider: "wikipedia", headers: headers(), timeoutMs: 20_000, signal });
  return searchSchema.parse(res).query?.search ?? [];
}

export async function wikipediaExtract(pageid: number, signal?: AbortSignal): Promise<WebSource & { text: string }> {
  const params = new URLSearchParams({ action: "query", prop: "extracts|info", inprop: "url", explaintext: "1", exsectionformat: "plain", pageids: String(pageid), format: "json", origin: "*" });
  const res = extractSchema.parse(await requestJson<unknown>(`${API}?${params}`, { provider: "wikipedia", headers: headers(), timeoutMs: 20_000, signal }));
  const page = Object.values(res.query.pages)[0];
  const text = (page?.extract ?? "").replace(/\n{3,}/g, "\n\n").slice(0, MAX_CHARS_PER_PAGE);
  return {
    url: page?.fullurl ?? `https://en.wikipedia.org/?curid=${pageid}`,
    title: `${page?.title ?? "Wikipedia"} - Wikipedia`,
    text,
    citedText: text.slice(0, 300),
  };
}

/** Searches several queries and returns the most relevant unique pages with excerpts. */
export async function researchOnWikipedia(queries: string[], maxPages = 4, signal?: AbortSignal): Promise<(WebSource & { text: string })[]> {
  const seen = new Set<number>();
  const pages: (WebSource & { text: string })[] = [];
  for (const query of queries) {
    for (const hit of await searchWikipedia(query, 3, signal)) {
      if (seen.has(hit.pageid) || pages.length >= maxPages) continue;
      seen.add(hit.pageid);
      const page = await wikipediaExtract(hit.pageid, signal);
      if (page.text.length > 200) pages.push(page);
    }
    if (pages.length >= maxPages) break;
  }
  return pages;
}
