import { getEnv } from "@/config/env";
import { isModelInstalled, LOCAL_MODELS } from "./models";

/**
 * Readiness of the free local AI stack, shown on the Settings page:
 * Ollama reachable + model pulled, and whether the speech models are downloaded yet
 * (they download automatically on first use).
 */
export interface LocalAiStatus {
  ollama: { baseUrl: string; reachable: boolean; model: string; modelInstalled: boolean; installedModels: string[]; error?: string };
  kokoroInstalled: boolean;
  parakeetInstalled: boolean;
}

export async function localAiStatus(ollamaModel: string): Promise<LocalAiStatus> {
  const baseUrl = getEnv().OLLAMA_BASE_URL;
  let reachable = false;
  let installedModels: string[] = [];
  let error: string | undefined;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      reachable = true;
      const body = (await res.json()) as { models?: { name: string }[] };
      installedModels = (body.models ?? []).map((m) => m.name);
    } else error = `HTTP ${res.status}`;
  } catch (err) {
    error = (err as Error).message;
  }
  const wanted = ollamaModel.includes(":") ? ollamaModel : `${ollamaModel}:latest`;
  return {
    ollama: { baseUrl, reachable, model: ollamaModel, modelInstalled: installedModels.includes(wanted) || installedModels.includes(ollamaModel), installedModels, error },
    kokoroInstalled: await isModelInstalled(LOCAL_MODELS["kokoro-en"]),
    parakeetInstalled: await isModelInstalled(LOCAL_MODELS["parakeet-en"]),
  };
}
