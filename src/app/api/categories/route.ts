import type { NextRequest } from "next/server";
import { z } from "zod";
import { authedRoute, json, parseBody } from "@/lib/api";
import { db } from "@/lib/db";
import { ConflictError, LanguageValidationError, NotFoundError } from "@/lib/errors";
import { analyzeLanguage } from "@/services/language/language-service";

const createSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional(),
  promptHints: z.string().trim().max(500).optional(),
});

export const GET = authedRoute(async () => json({ categories: await db.topicCategory.findMany({ orderBy: { sortOrder: "asc" } }) }));

/** Adds a new topic category (architecture supports unlimited categories). */
export const POST = authedRoute(async (req: NextRequest, { user }) => {
  const body = await parseBody(req, createSchema);
  const analysis = analyzeLanguage(body.name, "topic");
  if (!analysis.isEnglish) throw new LanguageValidationError("category name", analysis.reasons, false);
  const key = body.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (await db.topicCategory.findUnique({ where: { key } })) throw new ConflictError("A category with this name already exists");
  const max = await db.topicCategory.aggregate({ _max: { sortOrder: true } });
  const category = await db.topicCategory.create({ data: { key, name: body.name, description: body.description, promptHints: body.promptHints, userId: user.id, sortOrder: (max._max.sortOrder ?? 0) + 1 } });
  return json({ category }, { status: 201 });
});

export const PATCH = authedRoute(async (req: NextRequest) => {
  const body = await parseBody(req, z.object({ key: z.string(), enabled: z.boolean() }));
  const category = await db.topicCategory.findUnique({ where: { key: body.key } });
  if (!category) throw new NotFoundError("Category", body.key);
  return json({ category: await db.topicCategory.update({ where: { key: body.key }, data: { enabled: body.enabled } }) });
});
