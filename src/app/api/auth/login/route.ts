import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { clientIp, json, route } from "@/lib/api";
import { sessionCookieOptions } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { authenticate, createSession, SESSION_COOKIE } from "@/services/auth/auth-service";

export const POST = route(async (req: NextRequest) => {
  const ip = clientIp(req);
  await rateLimit(`login:${ip}`, 10, 15 * 60);
  const body: unknown = await req.json().catch(() => ({}));
  const user = await authenticate(body);
  const session = await createSession(user.id, { ipAddress: ip, userAgent: req.headers.get("user-agent") });
  (await cookies()).set(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
  return json({ user });
});
