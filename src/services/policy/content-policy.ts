import { ContentPolicyError } from "@/lib/errors";

/**
 * Content policy gate (first line of defence, before any AI call).
 *
 * The application must not produce: illegal or dangerous instructions, fraud, hate,
 * sexually explicit or extremely graphic content, deceptive misinformation, or
 * copyright-infringing material. This deterministic filter blocks obviously
 * disallowed requests; the AI script review performs the nuanced second check.
 */
interface PolicyRule {
  category: string;
  pattern: RegExp;
}

const RULES: PolicyRule[] = [
  { category: "dangerous_instructions", pattern: /\b(how to|steps? to|guide to|tutorial)\b.{0,40}\b(make|build|synthesi[sz]e|cook|brew)\b.{0,30}\b(bomb|explosive|napalm|nerve agent|sarin|ricin|meth(amphetamine)?|fentanyl|poison|weapon|gun|ghost gun)\b/i },
  { category: "dangerous_instructions", pattern: /\b(pipe bomb|ied|molotov)\b.{0,30}\b(make|build|instructions?)\b/i },
  { category: "self_harm", pattern: /\b(how to|ways to|best way to)\b.{0,30}\b(kill yourself|commit suicide|self[- ]harm)\b/i },
  { category: "fraud", pattern: /\b(how to|guide to)\b.{0,40}\b(scam|phish|launder money|counterfeit|steal credit cards?|carding|hack into)\b/i },
  { category: "sexual_content", pattern: /\b(porn(ography)?|explicit sex|nude|nsfw|xxx)\b/i },
  { category: "hate", pattern: /\b(why|proof)\b.{0,40}\b(race|religion|ethnicity|gay people|women|immigrants)\b.{0,30}\b(inferior|subhuman|should be (banned|eliminated))\b/i },
  { category: "graphic_violence", pattern: /\b(gore|beheading|dismember(ed|ment)?|snuff)\b/i },
  { category: "copyright", pattern: /\b(full (movie|episode|album)|reupload|re-upload|pirated?|torrent)\b/i },
];

export interface PolicyVerdict {
  allowed: boolean;
  categories: string[];
}

export function checkContentPolicy(text: string): PolicyVerdict {
  const categories = [...new Set(RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.category))];
  return { allowed: categories.length === 0, categories };
}

export function assertContentAllowed(text: string, field = "content"): void {
  const verdict = checkContentPolicy(text);
  if (!verdict.allowed) {
    throw new ContentPolicyError(`The ${field} violates the content policy (${verdict.categories.join(", ")})`, {
      categories: verdict.categories,
    });
  }
}

/** Shared instruction appended to every generation prompt. */
export const CONTENT_POLICY_PROMPT = `Content policy (mandatory):
- Educational, entertaining, factual and visually interesting content only.
- Never produce illegal or dangerous instructions, fraud, hate, harassment, sexual content, extreme graphic content, medical or financial advice presented as fact, or deceptive misinformation.
- Never present speculation, rumours or disputed claims as established fact.
- Never reproduce copyrighted text such as song lyrics or book passages.`;

/** Shared English-only instruction appended to every generation prompt. */
export const ENGLISH_ONLY_PROMPT = `Language requirement (mandatory): write ALL output exclusively in natural, fluent English. Never use any other language, even if the topic, sources or input are in another language. Translate foreign terms into English or explain them in English.`;
