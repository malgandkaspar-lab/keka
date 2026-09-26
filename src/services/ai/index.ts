import { getEnv, requireCredential } from "@/config/env";
import type { UserSettings } from "@/services/settings/schema";
import { AnthropicProvider } from "./anthropic-provider";
import { OllamaProvider } from "./ollama-provider";
import type { AIProvider } from "./types";

/**
 * AI provider factory. The provider and model come from user settings; the API key
 * from the environment. Tests inject a fake provider with `setAIProviderForTesting`.
 */
let override: AIProvider | undefined;

export function getAIProvider(settings: Pick<UserSettings, "aiProvider" | "aiModel" | "ollamaModel">): AIProvider {
  if (override) return override;
  switch (settings.aiProvider) {
    case "ollama":
      return new OllamaProvider(settings.ollamaModel || getEnv().OLLAMA_MODEL, getEnv().OLLAMA_BASE_URL);
    case "anthropic":
      return new AnthropicProvider({
        apiKey: requireCredential("ANTHROPIC_API_KEY"),
        model: settings.aiModel || getEnv().ANTHROPIC_MODEL,
      });
    default:
      throw new Error(`Unsupported AI provider: ${String(settings.aiProvider)}`);
  }
}

export function setAIProviderForTesting(provider: AIProvider | undefined): void {
  override = provider;
}

export type { AIProvider } from "./types";
