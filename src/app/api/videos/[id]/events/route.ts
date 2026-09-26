import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";

/**
 * Real-time generation progress via Server-Sent Events.
 * Streams the video status, per-step job progress and new log lines every ~1.5s until
 * the client disconnects (or 15 minutes pass; EventSource reconnects automatically).
 */
export const dynamic = "force-dynamic";

const POLL_MS = 1500;
const MAX_STREAM_MS = 15 * 60_000;

export async function GET(req: NextRequest, ctx: RouteContext<"/api/videos/[id]/events">) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const exists = await db.video.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!exists) throw new NotFoundError("Video", id);

    const encoder = new TextEncoder();
    let lastLogAt = new Date(Number(req.nextUrl.searchParams.get("since") ?? 0) || 0);
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        const tick = async () => {
          try {
            const video = await db.video.findUnique({
              where: { id },
              select: { status: true, error: true, failedStep: true, updatedAt: true, youtubeUrl: true },
            });
            if (!video) {
              send("deleted", {});
              controller.close();
              return;
            }
            const jobs = await db.generationJob.findMany({
              where: { videoId: id },
              orderBy: { createdAt: "asc" },
              select: { id: true, step: true, status: true, progress: true, attempts: true, error: true, durationMs: true },
            });
            const logs = await db.systemLog.findMany({
              where: { videoId: id, createdAt: { gt: lastLogAt } },
              orderBy: { createdAt: "asc" },
              take: 200,
              select: { id: true, level: true, message: true, step: true, createdAt: true },
            });
            if (logs.length) lastLogAt = logs.at(-1)!.createdAt;
            send("progress", { video, jobs, logs });
            if (Date.now() - started > MAX_STREAM_MS) {
              controller.close();
              return;
            }
            timer = setTimeout(() => void tick(), POLL_MS);
          } catch {
            controller.close();
          }
        };
        void tick();
      },
      cancel() {
        if (timer) clearTimeout(timer);
      },
    });
    req.signal.addEventListener("abort", () => timer && clearTimeout(timer));
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
