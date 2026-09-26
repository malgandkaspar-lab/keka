import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { getEnv } from "@/config/env";
import { disconnectDb } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import { closeRedis, createRedisConnection } from "@/lib/redis";
import { processStepJob } from "@/jobs/runner";
import { closeQueues, type StepJobData } from "@/queues";
import { reconcilePipeline } from "@/services/pipeline/recovery";
import { processMaintenanceJob, registerMaintenanceSchedules } from "./maintenance";

/**
 * Background worker process (run separately from the Next.js server):
 *   npm run worker
 *
 * Long-running generation never happens inside an HTTP request. The web app only
 * enqueues jobs; this process executes them with per-queue concurrency, BullMQ stalled
 * job recovery (lockDuration) and graceful shutdown on SIGTERM/SIGINT.
 */
process.env.SERVICE_NAME ??= "shorts-factory-worker";
const log = createLogger({ module: "worker" });

async function main(): Promise<void> {
  const env = getEnv();
  const common = { lockDuration: 120_000, stalledInterval: 60_000, maxStalledCount: 2 };
  const stepProcessor = (job: Job<StepJobData>) => processStepJob(job);

  const workers = [
    new Worker<StepJobData>("pipeline", stepProcessor, { ...common, connection: createRedisConnection(), concurrency: env.WORKER_CONCURRENCY }),
    new Worker<StepJobData>("render", stepProcessor, { ...common, connection: createRedisConnection(), concurrency: env.RENDER_CONCURRENCY, lockDuration: 300_000 }),
    new Worker<StepJobData>("publish", stepProcessor, { ...common, connection: createRedisConnection(), concurrency: 1, lockDuration: 600_000 }),
    new Worker("maintenance", processMaintenanceJob, { ...common, connection: createRedisConnection(), concurrency: 1 }),
  ];

  for (const worker of workers) {
    worker.on("failed", (job, err) => log.warn({ queue: worker.name, jobId: job?.id, name: job?.name, err: err.message }, "job failed"));
    worker.on("error", (err) => log.error({ queue: worker.name, err: err.message }, "worker error"));
  }

  await registerMaintenanceSchedules();
  const recovered = await reconcilePipeline();
  log.info({ queues: workers.map((w) => w.name), recovered }, "worker started");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down worker (waiting for active jobs)");
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
    await closeRedis();
    await disconnectDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  log.fatal({ err: error }, "worker failed to start");
  process.exit(1);
});
