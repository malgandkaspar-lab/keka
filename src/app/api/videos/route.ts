import type { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { authedRoute, json, parseQuery } from "@/lib/api";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { createVideo } from "@/services/videos/video-service";

const listQuery = z.object({
  status: z.string().optional(),
  q: z.string().max(200).optional(),
  take: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export const GET = authedRoute(async (req: NextRequest, { user }) => {
  const query = parseQuery(req, listQuery);
  const where: Prisma.VideoWhereInput = { userId: user.id };
  if (query.status) where.status = query.status as Prisma.EnumVideoStatusFilter["equals"];
  if (query.q) where.OR = [{ title: { contains: query.q, mode: "insensitive" } }, { requestedTopic: { contains: query.q, mode: "insensitive" } }];
  const [videos, total] = await Promise.all([
    db.video.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: query.take,
      skip: query.skip,
      select: {
        id: true, title: true, status: true, requestedTopic: true, actualDurationSec: true, targetDurationSec: true,
        createdAt: true, youtubeUrl: true, youtubeStatus: true, privacy: true, thumbnailAsset: { select: { storageKey: true } },
      },
    }),
    db.video.count({ where }),
  ]);
  return json({ videos, total });
});

export const POST = authedRoute(async (req: NextRequest, { user }) => {
  await rateLimit(`create-video:${user.id}`, 30, 60 * 60);
  const body: unknown = await req.json().catch(() => ({}));
  const { video, similarTopic } = await createVideo(user.id, body as Parameters<typeof createVideo>[1]);
  return json({ video: { id: video.id, status: video.status }, similarTopic }, { status: 201 });
});
