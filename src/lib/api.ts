import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import { AppError, ForbiddenError, ValidationError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { requireUser } from "@/lib/auth";
import type { SessionUser } from "@/services/auth/auth-service";

/**
 * Route handler helpers: typed JSON responses, structured error mapping, CSRF origin
 * checks for mutating requests and Zod body validation.
 */
const log = createLogger({ module: "api" });

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export function json<T>(data: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(data, init);
}

export function errorResponse(error: unknown): NextResponse<ApiErrorBody> {
  if (error instanceof AppError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      { status: error.statusCode },
    );
  }
  log.error({ err: error }, "unhandled API error");
  return NextResponse.json(
    { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } },
    { status: 500 },
  );
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Rejects cross-site mutating requests (defence in depth on top of SameSite cookies). */
export function assertSameOrigin(req: NextRequest): void {
  if (!MUTATING.has(req.method)) return;
  const origin = req.headers.get("origin");
  if (!origin) return; // Non-browser clients (curl, server-to-server) do not send Origin.
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ForbiddenError("Invalid Origin header");
  }
  if (host && originHost !== host) throw new ForbiddenError("Cross-origin request rejected");
}

type Handler<Ctx> = (req: NextRequest, ctx: Ctx) => Promise<Response>;
type AuthedHandler<Ctx> = (req: NextRequest, ctx: Ctx & { user: SessionUser }) => Promise<Response>;

export function route<Ctx>(handler: Handler<Ctx>): Handler<Ctx> {
  return async (req, ctx) => {
    try {
      assertSameOrigin(req);
      return await handler(req, ctx);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function authedRoute<Ctx>(handler: AuthedHandler<Ctx>): Handler<Ctx> {
  return route(async (req, ctx) => {
    const user = await requireUser();
    return handler(req, { ...ctx, user });
  });
}

export async function parseBody<S extends z.ZodType>(req: NextRequest, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid request body", { issues: parsed.error.issues });
  return parsed.data;
}

export function parseQuery<S extends z.ZodType>(req: NextRequest, schema: S): z.infer<S> {
  const params = Object.fromEntries(req.nextUrl.searchParams.entries());
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw new ValidationError("Invalid query parameters", { issues: parsed.error.issues });
  return parsed.data;
}

export function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "unknown";
}
