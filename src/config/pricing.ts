/**
 * Price table used for *estimated* cost tracking. Values are USD and can be adjusted
 * here when provider pricing changes; actual billing is always the provider's.
 */
export const AI_MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-fable-5-1": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

const FALLBACK_PRICING = { inputPerMTok: 5, outputPerMTok: 25 };

export const WEB_SEARCH_COST_PER_SEARCH = 0.01;
/** ElevenLabs: approximate USD per 1,000 characters (depends on plan). */
export const TTS_COST_PER_1K_CHARS = 0.18;
/** Speech-to-text: approximate USD per audio minute. */
export const STT_COST_PER_MINUTE = 0.006;

export function estimateAiCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = AI_MODEL_PRICING[model] ?? FALLBACK_PRICING;
  return (inputTokens / 1e6) * price.inputPerMTok + (outputTokens / 1e6) * price.outputPerMTok;
}
