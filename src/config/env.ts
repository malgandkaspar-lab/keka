import { z } from "zod";
import { MissingCredentialError } from "@/lib/errors";

/**
 * Environment configuration.
 *
 * Every secret is read from the process environment. Nothing here is ever sent to the
 * browser: only modules that run on the server (route handlers, server components, the
 * worker) import this file.
 */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  ENCRYPTION_KEY: z.string().min(1, "ENCRYPTION_KEY is required (32 bytes, base64)"),
  ALLOW_REGISTRATION: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: z.string().default("claude-opus-5"),
  ELEVENLABS_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,
  PEXELS_API_KEY: optionalString,

  YOUTUBE_CLIENT_ID: optionalString,
  YOUTUBE_CLIENT_SECRET: optionalString,
  YOUTUBE_REDIRECT_URI: optionalString,

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./storage"),
  STORAGE_ENDPOINT: optionalString,
  STORAGE_REGION: z.string().default("us-east-1"),
  STORAGE_ACCESS_KEY: optionalString,
  STORAGE_SECRET_KEY: optionalString,
  STORAGE_BUCKET: optionalString,
  STORAGE_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  FONTS_DIR: z.string().default("/usr/share/fonts/truetype"),
  WORK_DIR: z.string().default("./storage/tmp"),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid environment configuration: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Test helper: forget the cached environment so tests can change process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}

type CredentialName =
  | "ANTHROPIC_API_KEY"
  | "ELEVENLABS_API_KEY"
  | "OPENAI_API_KEY"
  | "PEXELS_API_KEY"
  | "YOUTUBE_CLIENT_ID"
  | "YOUTUBE_CLIENT_SECRET"
  | "YOUTUBE_REDIRECT_URI"
  | "STORAGE_ACCESS_KEY"
  | "STORAGE_SECRET_KEY"
  | "STORAGE_BUCKET";

/**
 * Returns a credential or throws a MissingCredentialError that names exactly
 * which environment variable must be configured.
 */
export function requireCredential(name: CredentialName): string {
  const value = getEnv()[name];
  if (!value) throw new MissingCredentialError(name);
  return value;
}

export function hasCredential(name: CredentialName): boolean {
  return Boolean(getEnv()[name]);
}

/** Integration readiness, shown on the Settings page (never exposes values). */
export function credentialStatus(): Record<string, boolean> {
  const env = getEnv();
  return {
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    elevenlabs: Boolean(env.ELEVENLABS_API_KEY),
    openaiWhisper: Boolean(env.OPENAI_API_KEY),
    pexels: Boolean(env.PEXELS_API_KEY),
    youtube: Boolean(env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET && env.YOUTUBE_REDIRECT_URI),
    s3: env.STORAGE_DRIVER === "s3" && Boolean(env.STORAGE_BUCKET && env.STORAGE_ACCESS_KEY && env.STORAGE_SECRET_KEY),
  };
}
