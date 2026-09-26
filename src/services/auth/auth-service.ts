import { z } from "zod";
import { db } from "@/lib/db";
import { randomToken, sha256 } from "@/lib/crypto";
import { AuthenticationError, ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { hashPassword, verifyPassword } from "./password";

/**
 * AuthService
 *
 * Purpose: secure, server-side session authentication.
 * - Passwords hashed with Argon2id.
 * - Session tokens are 256-bit random values; only their SHA-256 hash is stored.
 * - Sessions expire after SESSION_TTL_DAYS and are extended on use (sliding window).
 * - The first registered user becomes ADMIN; further self-registration requires
 *   ALLOW_REGISTRATION=true.
 */
export const SESSION_COOKIE = "sf_session";
export const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_MS = 24 * 60 * 60 * 1000;

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10, "Password must be at least 10 characters").max(200),
});

export const registerSchema = credentialsSchema.extend({
  name: z.string().trim().min(1).max(100).optional(),
});

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: "ADMIN" | "USER";
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

export async function registerUser(input: unknown, allowRegistration: boolean): Promise<SessionUser> {
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid registration details", { issues: parsed.error.issues });
  const { email, password, name } = parsed.data;

  const userCount = await db.user.count();
  if (userCount > 0 && !allowRegistration) {
    throw new ForbiddenError("Registration is disabled. Ask an administrator to enable ALLOW_REGISTRATION.");
  }
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) throw new ConflictError("An account with this email already exists");

  const passwordHash = await hashPassword(password);
  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { email, name: name ?? null, passwordHash, role: userCount === 0 ? "ADMIN" : "USER" },
    });
    await tx.project.create({ data: { userId: created.id, name: "Default", isDefault: true } });
    return created;
  });
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export async function authenticate(input: unknown): Promise<SessionUser> {
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) throw new AuthenticationError("Invalid email or password");
  const user = await db.user.findUnique({ where: { email: parsed.data.email } });
  // Always run a verification to keep timing similar for unknown emails.
  const ok = user
    ? await verifyPassword(user.passwordHash, parsed.data.password)
    : await verifyPassword(await dummyHash(), parsed.data.password);
  if (!user || !ok) throw new AuthenticationError("Invalid email or password");
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

// Hash of a random throwaway password, so unknown emails cost the same as wrong passwords.
let dummyHashPromise: Promise<string> | undefined;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomToken(24));
  return dummyHashPromise;
}

export async function createSession(
  userId: string,
  meta: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<CreatedSession> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt,
      ipAddress: meta.ipAddress?.slice(0, 64) ?? null,
      userAgent: meta.userAgent?.slice(0, 256) ?? null,
    },
  });
  return { token, expiresAt };
}

/** Validates a raw session token and returns the user, extending the session if needed. */
export async function validateSession(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now) {
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  if (now - session.lastUsedAt.getTime() > SESSION_REFRESH_MS) {
    await db.session.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date(now), expiresAt: new Date(now + SESSION_TTL_MS) },
    });
  }
  const { user } = session;
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export async function revokeSession(token: string): Promise<void> {
  await db.session.deleteMany({ where: { tokenHash: sha256(token) } });
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await db.session.deleteMany({ where: { userId } });
}

export async function purgeExpiredSessions(): Promise<number> {
  const res = await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return res.count;
}
