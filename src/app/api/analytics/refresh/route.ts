import { authedRoute, json } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { getQueue } from "@/queues";

/** Queues an analytics collection for the current user's channels (runs in the worker). */
export const POST = authedRoute(async (_req, { user }) => {
  await rateLimit(`analytics-refresh:${user.id}`, 6, 3600);
  await getQueue("maintenance").add("collect-analytics-user", { userId: user.id }, { jobId: `analytics-${user.id}-${Math.floor(Date.now() / 60_000)}` });
  return json({ queued: true });
});
