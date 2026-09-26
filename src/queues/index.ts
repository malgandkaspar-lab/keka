import { Queue, type JobsOptions } from "bullmq";
import { createRedisConnection } from "@/lib/redis";
import type { QueueName } from "@/services/pipeline/steps";

/**
 * BullMQ queues.
 *  - pipeline:    AI + media steps (topic, research, script, voice, footage, subtitles...)
 *  - render:      CPU-heavy FFmpeg work (render, quality check, thumbnail)
 *  - publish:     YouTube upload/publish (isolated so uploads retry independently)
 *  - maintenance: scheduler ticks, analytics collection, cleanup
 *
 * Jobs are durable in Redis (enable AOF persistence in production - see docker-compose),
 * retried with exponential backoff, and kept for inspection after completion.
 */
export interface StepJobData {
  videoId: string;
  generationJobId: string;
  step: string;
  userId: string;
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

const globalForQueues = globalThis as unknown as { __queues?: Map<QueueName, Queue> };

export function getQueue(name: QueueName): Queue {
  globalForQueues.__queues ??= new Map();
  let queue = globalForQueues.__queues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: createRedisConnection(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
    globalForQueues.__queues.set(name, queue);
  }
  return queue;
}

export async function closeQueues(): Promise<void> {
  const queues = globalForQueues.__queues;
  if (!queues) return;
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}

export const QUEUE_NAMES: QueueName[] = ["pipeline", "render", "publish", "maintenance"];
