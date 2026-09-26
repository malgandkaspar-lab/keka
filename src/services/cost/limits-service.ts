import { db } from "@/lib/db";
import { LimitExceededError } from "@/lib/errors";
import type { UserSettings } from "@/services/settings/schema";

/**
 * Cost control: daily / monthly generation limits and a monthly estimated budget.
 * Every GenerationJob records its estimated cost; videos accumulate costEstimateUsd.
 */
export interface UsageSummary {
  videosToday: number;
  videosThisMonth: number;
  costToday: number;
  costThisMonth: number;
  dailyLimit: number;
  monthlyLimit: number;
  monthlyBudgetUsd: number;
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function usageSummary(userId: string, settings: UserSettings): Promise<UsageSummary> {
  const [today, month, costToday, costMonth] = await Promise.all([
    db.video.count({ where: { userId, createdAt: { gte: startOfUtcDay() } } }),
    db.video.count({ where: { userId, createdAt: { gte: startOfUtcMonth() } } }),
    db.generationJob.aggregate({ where: { userId, createdAt: { gte: startOfUtcDay() } }, _sum: { costUsd: true } }),
    db.generationJob.aggregate({ where: { userId, createdAt: { gte: startOfUtcMonth() } }, _sum: { costUsd: true } }),
  ]);
  return {
    videosToday: today,
    videosThisMonth: month,
    costToday: Number((costToday._sum.costUsd ?? 0).toFixed(4)),
    costThisMonth: Number((costMonth._sum.costUsd ?? 0).toFixed(4)),
    dailyLimit: settings.dailyGenerationLimit,
    monthlyLimit: settings.monthlyGenerationLimit,
    monthlyBudgetUsd: settings.monthlyBudgetUsd,
  };
}

export async function assertWithinLimits(userId: string, settings: UserSettings, count = 1): Promise<UsageSummary> {
  const usage = await usageSummary(userId, settings);
  if (usage.videosToday + count > usage.dailyLimit) {
    throw new LimitExceededError(`Daily generation limit reached (${usage.dailyLimit} videos/day)`, { ...usage });
  }
  if (usage.videosThisMonth + count > usage.monthlyLimit) {
    throw new LimitExceededError(`Monthly generation limit reached (${usage.monthlyLimit} videos/month)`, { ...usage });
  }
  if (usage.costThisMonth >= usage.monthlyBudgetUsd) {
    throw new LimitExceededError(`Monthly budget of $${usage.monthlyBudgetUsd} reached (estimated $${usage.costThisMonth})`, { ...usage });
  }
  return usage;
}
