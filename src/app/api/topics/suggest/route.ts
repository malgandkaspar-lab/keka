import type { NextRequest } from "next/server";
import { z } from "zod";
import { authedRoute, json, parseBody } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { getAIProvider } from "@/services/ai";
import { performanceHints } from "@/services/analytics/insights";
import { getUserSettings } from "@/services/settings/settings-service";
import { generateTopic } from "@/services/topics/topic-service";

/** Suggests one AI-selected, deduplicated English topic for the Generate form. */
export const POST = authedRoute(async (req: NextRequest, { user }) => {
  await rateLimit(`suggest-topic:${user.id}`, 20, 60 * 60);
  const { category } = await parseBody(req, z.object({ category: z.string().min(1) }));
  const settings = await getUserSettings(user.id);
  const result = await generateTopic({
    userId: user.id,
    categoryKey: category,
    ai: getAIProvider(settings),
    minScore: settings.minTopicScore,
    similarityThreshold: settings.topicSimilarityThreshold,
    performanceHints: await performanceHints(user.id),
    signal: AbortSignal.timeout(90_000),
  });
  return json({ topic: { id: result.topic.id, title: result.topic.title, angle: result.topic.angle, score: result.topic.overallScore } });
});
