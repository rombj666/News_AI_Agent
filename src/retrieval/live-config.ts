import { z } from 'zod';
export class LiveConfigError extends Error {}

export function liveRetrievalConfig(env: Record<string, string | undefined>) {
  const result = z.object({
    RUN_LIVE_RETRIEVAL: z.literal('YES'),
    LIVE_RSS_SOURCE_ID: z.string().min(1),
    BRAVE_API_KEY: z.string().trim().min(1),
    LIVE_BRAVE_QUERY: z.string().trim().min(1).max(400).refine((value) => value.split(/\s+/).length <= 50),
    BRAVE_COST_PER_REQUEST_NANODOLLARS: z.string().regex(/^[1-9]\d{0,12}$/),
    BRAVE_PRICING_VERSION: z.string().trim().min(1).max(120),
    RETRIEVAL_MONTHLY_BUDGET_NANODOLLARS: z.string().regex(/^[1-9]\d{0,12}$/),
  }).safeParse(env);
  if (!result.success) {
    throw new LiveConfigError(`Live retrieval disabled. Required/invalid fields: ${[...new Set(result.error.issues.map((issue) => issue.path.join('.')))].join(', ')}`);
  }
  const data = result.data;
  const cost = BigInt(data.BRAVE_COST_PER_REQUEST_NANODOLLARS);
  const budget = BigInt(data.RETRIEVAL_MONTHLY_BUDGET_NANODOLLARS);
  if (cost > budget) throw new LiveConfigError('Live request estimate exceeds retrieval budget');
  return {
    rssSourceId: data.LIVE_RSS_SOURCE_ID, braveKey: data.BRAVE_API_KEY, query: data.LIVE_BRAVE_QUERY,
    limits: { braveCostPerRequest: cost, monthlyBudget: budget, dailyRequests: 10, pricingVersion: data.BRAVE_PRICING_VERSION },
  };
}
