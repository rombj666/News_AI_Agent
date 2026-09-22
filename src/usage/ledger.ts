import { z } from 'zod';
import { asUser, type Database, type Queryable } from '../db/database.js';
import { uuidSchema } from '../domain/preferences.js';
import { LUNA_MODEL } from '../config/index.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.object({
  operationId: uuidSchema, attempt: count.min(1),
  provider: z.enum(['openai', 'brave', 'demo']), model: z.literal(LUNA_MODEL).nullable(),
  jobType: z.string().regex(/^[a-z_]{1,60}$/), requestId: z.string().max(200).nullable(),
  status: z.enum(['succeeded', 'failed', 'unknown']),
  inputTokens: count.nullable(), cachedInputTokens: count.nullable(), outputTokens: count.nullable(),
  searchCalls: count.nullable(), estimatedCostNanodollars: z.bigint().nonnegative().max(9_223_372_036_854_775_807n).nullable(),
  rateSnapshot: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  executionTimeMs: count, createdAt: z.date(),
}).strict().superRefine((entry, ctx) => {
  if (entry.cachedInputTokens !== null && (entry.inputTokens === null || entry.cachedInputTokens > entry.inputTokens)) {
    ctx.addIssue({ code: 'custom', message: 'Cached input must be a subset of input' });
  }
  if (entry.provider === 'openai' && entry.model !== LUNA_MODEL) ctx.addIssue({ code: 'custom', message: 'Luna required' });
  if (entry.provider === 'brave' && entry.model !== null) ctx.addIssue({ code: 'custom', message: 'Search has no model' });
  if (entry.provider === 'openai' && (entry.inputTokens === null || entry.cachedInputTokens === null || entry.outputTokens === null)
    && entry.estimatedCostNanodollars !== null) ctx.addIssue({ code: 'custom', message: 'Unknown token usage must have unknown cost' });
  if (entry.provider === 'brave' && entry.searchCalls === null && entry.estimatedCostNanodollars !== null) {
    ctx.addIssue({ code: 'custom', message: 'Unknown search usage must have unknown cost' });
  }
});

export type UsageEntry = z.infer<typeof usageSchema>;

async function insert(tx: Queryable, userId: string | null, scope: 'user' | 'shared', entry: UsageEntry): Promise<boolean> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO ai_usage
      (user_id, scope, operation_id, attempt, provider, model, job_type, request_id, status,
       input_tokens, cached_input_tokens, output_tokens, search_calls, estimated_cost_nanodollars,
       rate_snapshot, execution_time_ms, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17)
     ON CONFLICT DO NOTHING RETURNING id`,
    [userId, scope, entry.operationId, entry.attempt, entry.provider, entry.model, entry.jobType,
      entry.requestId, entry.status, entry.inputTokens, entry.cachedInputTokens, entry.outputTokens,
      entry.searchCalls, entry.estimatedCostNanodollars?.toString() ?? null, JSON.stringify(entry.rateSnapshot),
      entry.executionTimeMs, entry.createdAt.toISOString()],
  );
  return result.rows.length === 1;
}

// Reuse the same ledger inside a collection settlement transaction.
export async function recordUsageInTransaction(tx: Queryable, userId: string | null, raw: UsageEntry): Promise<boolean> {
  return insert(tx, userId, userId === null ? 'shared' : 'user', usageSchema.parse(raw));
}

export async function recordUserUsage(db: Database, userId: string, raw: UsageEntry): Promise<boolean> {
  const entry = usageSchema.parse(raw);
  return asUser(db, userId, (tx) => insert(tx, userId, 'user', entry));
}

// Shared collector path is not accessible via the per-user runtime role.
export async function recordSharedUsage(collectorDb: Database, raw: UsageEntry): Promise<boolean> {
  const entry = usageSchema.parse(raw);
  return collectorDb.transaction((tx) => insert(tx, null, 'shared', entry));
}

export async function userUsageSummary(db: Database, userId: string, since: Date, until: Date) {
  if (!Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime()) || since >= until) throw new Error('Invalid period');
  return asUser(db, userId, async (tx) => {
    const { rows } = await tx.query<{ provider: string; cost: string; attempts: number; unknown: number }>(
      `SELECT provider, COALESCE(SUM(estimated_cost_nanodollars), 0)::text AS cost,
       COUNT(*)::integer AS attempts,
       COUNT(*) FILTER (WHERE estimated_cost_nanodollars IS NULL)::integer AS unknown
       FROM ai_usage WHERE user_id = $1 AND scope = 'user' AND created_at >= $2 AND created_at < $3
       GROUP BY provider ORDER BY provider`, [userId, since.toISOString(), until.toISOString()],
    );
    return rows.map((row) => ({ provider: row.provider, knownCostNanodollars: BigInt(row.cost), attempts: row.attempts, unknownCostAttempts: row.unknown }));
  });
}
