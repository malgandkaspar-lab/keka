import { db } from "@/lib/db";
import { hashPassword } from "@/services/auth/password";
import { seed } from "../../prisma/seed";

/** Test database helpers (isolated test database, see tests/setup.ts). */
const TABLES = [
  "AnalyticsSnapshot", "PerformanceInsight", "SystemLog", "PublishJob", "GenerationJob", "Subtitle", "VideoScene",
  "Voiceover", "ScriptVersion", "Script", "Video", "MusicTrack", "MediaAsset", "ResearchClaim", "ResearchReference",
  "Topic", "Schedule", "Channel", "YouTubeAccount", "AppSetting", "Session", "Project", "ApiCache", "User",
];

export async function resetDatabase(): Promise<void> {
  await db.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  // CASCADE also clears catalogs that reference users (templates, voices, categories).
  await seed(db);
}

export async function createTestUser(email = `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`) {
  const user = await db.user.create({ data: { email, passwordHash: await hashPassword("correct horse battery staple"), role: "ADMIN" } });
  await db.project.create({ data: { userId: user.id, name: "Default", isDefault: true } });
  return user;
}
