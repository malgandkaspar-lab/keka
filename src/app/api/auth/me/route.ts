import { authedRoute, json } from "@/lib/api";

export const GET = authedRoute(async (_req, { user }) => json({ user }));
