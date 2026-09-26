import type { LogLevel, PipelineStep } from "@/generated/prisma/client";

/** Context passed to every pipeline step handler. */
export interface StepContext {
  videoId: string;
  userId: string;
  jobId: string;
  step: PipelineStep;
  attempt: number;
  signal: AbortSignal;
  progress(percent: number, note?: string): Promise<void>;
  log(message: string, options?: { level?: LogLevel; provider?: string; context?: Record<string, unknown> }): Promise<void>;
}

export interface StepResult {
  output?: Record<string, unknown>;
  costUsd?: number;
  provider?: string;
  /** Message logged on success (defaults to the step's doneMessage). */
  message?: string;
  /** Send the pipeline back to an earlier step instead of advancing. */
  reroute?: { step: PipelineStep; reason: string };
}

export type StepHandler = (ctx: StepContext) => Promise<StepResult>;
