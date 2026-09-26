import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthenticationError } from "@/lib/errors";
import { SESSION_COOKIE, validateSession, type SessionUser } from "@/services/auth/auth-service";

/**
 * Next.js helpers for reading the current session from the secure httpOnly cookie.
 * Server-only: imported from server components and route handlers.
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  return validateSession(store.get(SESSION_COOKIE)?.value);
}

/** For route handlers: throws 401 when unauthenticated. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthenticationError();
  return user;
}

/** For server-rendered pages: redirects to /login when unauthenticated. */
export async function requirePageUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" && (process.env.APP_URL ?? "").startsWith("https://"),
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}
