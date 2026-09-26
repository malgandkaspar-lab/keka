import "dotenv/config";
import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { BUILT_IN_CATEGORIES, DEFAULT_VOICES, KOKORO_VOICE_SEEDS } from "../src/config/catalog";
import { BUILT_IN_TEMPLATES } from "../src/config/templates";

/**
 * Seeds configurable catalogs: topic categories, generation templates and English
 * voice presets. Idempotent: safe to run on every deploy.
 */
export async function seed(prisma: PrismaClient): Promise<void> {
  for (const [index, category] of BUILT_IN_CATEGORIES.entries()) {
    await prisma.topicCategory.upsert({
      where: { key: category.key },
      create: { ...category, sortOrder: index },
      update: { name: category.name, description: category.description, promptHints: category.promptHints, sortOrder: index },
    });
  }
  for (const template of BUILT_IN_TEMPLATES) {
    await prisma.generationTemplate.upsert({
      where: { key: template.key },
      create: { key: template.key, name: template.name, description: template.description, isBuiltIn: true, config: template.config },
      update: { name: template.name, description: template.description, config: template.config, isBuiltIn: true },
    });
  }
  for (const voice of [...KOKORO_VOICE_SEEDS, ...DEFAULT_VOICES]) {
    await prisma.voicePreset.upsert({
      where: { provider_voiceId: { provider: voice.provider, voiceId: voice.voiceId } },
      create: { ...voice, language: "en" },
      update: { name: voice.name, description: voice.description, gender: voice.gender, styles: voice.styles },
    });
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    await seed(prisma);
    console.log("Seed complete");
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
