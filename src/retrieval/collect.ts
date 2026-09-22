import { z } from 'zod';
import type { Database } from '../db/database.js';
import { uuidSchema } from '../domain/preferences.js';
import { systemClock, type Clock, type NewsRetriever, type RetrievalBatch } from '../domain/ports.js';
import { recordUsageInTransaction } from '../usage/ledger.js';
import { normalizeArticle, type NormalizedArticle } from './normalize.js';
import { persistArticle, syncSource } from './repository.js';
import { rssSourceSchema } from './sources.js';
import { RetrievalError } from './http.js';

const requestSchema = z.object({
  runId: uuidSchema, userId: uuidSchema.nullable().default(null),
  query: z.string().trim().max(400).default(''), category: z.string().trim().min(1).max(80),
  since: z.date(), limit: z.number().int().min(1).max(100).default(50),
  source: rssSourceSchema.optional(), blockedDomains: z.array(z.string().max(253)).max(100).default([]),
}).strict();
export type CollectionRequest = z.input<typeof requestSchema>;
export type CollectionLimits = {
  braveCostPerRequest: bigint; pricingVersion: string; monthlyBudget: bigint; dailyRequests: number;
};
export type RunRecord = {
  id: string; provider: 'rss' | 'brave'; user_id: string | null; query: string; category: string;
  request_key: string;
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  number_fetched: number; number_inserted: number; number_duplicates: number; number_filtered: number;
  number_failures: number; failures: { code: string; index?: number }[];
  estimated_cost_nanodollars: string | null; reserved_cost_nanodollars: string;
};

function validateLimits(limits: CollectionLimits) {
  if (limits.braveCostPerRequest <= 0n || limits.monthlyBudget < 0n
    || limits.monthlyBudget > 9_223_372_036_854_775_807n || limits.braveCostPerRequest > limits.monthlyBudget
    || !Number.isSafeInteger(limits.dailyRequests) || limits.dailyRequests < 1
    || !limits.pricingVersion || limits.pricingVersion.length > 120) throw new Error('Invalid Brave collection limits');
}

const selectRun = `SELECT id, provider, user_id, query, category, request_key, status, number_fetched, number_inserted,
  number_duplicates, number_filtered, number_failures, failures,
  estimated_cost_nanodollars::text, reserved_cost_nanodollars::text FROM retrieval_runs WHERE id = $1`;

export async function collectNews(
  db: Database, retriever: NewsRetriever, input: CollectionRequest,
  options: { limits?: CollectionLimits; clock?: Clock; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RunRecord> {
  const request = requestSchema.parse(input);
  const clock = options.clock ?? systemClock;
  const started = clock.now();
  if (request.since > started) throw new Error('Future collection window');
  if (retriever.provider === 'rss' && (!request.source?.enabled || request.query)) throw new Error('Enabled source and empty query required for RSS');
  if (retriever.provider === 'rss' && (retriever.source?.id !== request.source?.id || retriever.source?.url !== request.source?.url)) throw new Error('RSS source does not match adapter');
  if (retriever.provider === 'brave' && (request.source || !request.query || request.limit > 50 || request.query.split(/\s+/).length > 50)) throw new Error('Invalid Brave request');
  const limits = options.limits;
  if (retriever.provider === 'brave') { if (!limits) throw new Error('Brave limits required'); validateLimits(limits); }
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid timeout');
  options.signal?.throwIfAborted();
  const keyBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ ...request, provider: retriever.provider, runId: undefined })));
  // sources is shared: store only an opaque hash, never a private selection/profile.
  const requestKey = [...new Uint8Array(keyBytes)].map((value) => value.toString(16).padStart(2, '0')).join('');

  const prepared = await db.transaction(async (tx) => {
    // One account-level lock covers reservation and idempotency across collectors.
    await tx.query('SELECT pg_advisory_xact_lock(74102920)');
    const existing = await tx.query<RunRecord>(selectRun, [request.runId]);
    if (existing.rows[0]) {
      const previous = existing.rows[0];
      if (previous.request_key !== requestKey) {
        throw new Error('Run ID reused with different request');
      }
      return { existing: previous, cache: null };
    }
    const storedCache = request.source ? await syncSource(tx, request.source) : null;
    // Validators only apply to the same selection. A wider time window or a
    // changed blocklist must re-read the feed to recover previously filtered items.
    const cache = storedCache?.cache_key === requestKey ? storedCache : null;
    if (limits && retriever.provider === 'brave') {
      const month = new Date(Date.UTC(started.getUTCFullYear(), started.getUTCMonth(), 1)).toISOString();
      const nextMonth = new Date(Date.UTC(started.getUTCFullYear(), started.getUTCMonth() + 1, 1)).toISOString();
      const day = started.toISOString().slice(0, 10) + 'T00:00:00Z';
      const dayEnd = new Date(Date.parse(day) + 86_400_000).toISOString();
      const totals = await tx.query<{ held: string; daily: number }>(
        `SELECT COALESCE(SUM(CASE WHEN started_at >= $1 AND started_at < $2
            THEN COALESCE(estimated_cost_nanodollars, reserved_cost_nanodollars) ELSE 0 END),0)::text AS held,
          COUNT(*) FILTER (WHERE started_at >= $3 AND started_at < $4)::integer AS daily
         FROM retrieval_runs WHERE provider = 'brave'`, [month, nextMonth, day, dayEnd],
      );
      const total = totals.rows[0]!;
      if (BigInt(total.held) + limits.braveCostPerRequest > limits.monthlyBudget || total.daily >= limits.dailyRequests) {
        throw new Error('COLLECTION_ALLOWANCE_EXCEEDED');
      }
    }
    const reserve = retriever.provider === 'brave' ? limits!.braveCostPerRequest : 0n;
    await tx.query(`INSERT INTO retrieval_runs(id,user_id,provider,source_id,query,category,since_at,item_limit,request_key,
      started_at,reserved_cost_nanodollars,pricing_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [request.runId, request.userId, retriever.provider, request.source?.id ?? null, request.query, request.category,
      request.since.toISOString(), request.limit, requestKey, started.toISOString(), reserve.toString(), limits?.pricingVersion ?? 'rss-no-request-fee']);
    if (retriever.provider === 'brave') {
      // Write-ahead unknown usage survives process failure after the request starts.
      await recordUsageInTransaction(tx, request.userId, {
        operationId: request.runId, attempt: 1, provider: 'brave', model: null, jobType: 'news_collection', requestId: null,
        status: 'unknown', inputTokens: null, cachedInputTokens: null, outputTokens: null, searchCalls: 1,
        estimatedCostNanodollars: null, rateSnapshot: { version: limits!.pricingVersion, requestNanodollars: reserve.toString() },
        executionTimeMs: 0, createdAt: started,
      });
    }
    return { existing: null, cache };
  });
  if (prepared.existing) return prepared.existing;

  const failures: RetrievalBatch['failures'] = [];
  let batch: RetrievalBatch | null = null;
  const valid: { article: NormalizedArticle; index: number }[] = [];
  let filtered = 0;
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]);
  try {
    batch = await retriever.collect({ query: request.query, since: request.since, limit: request.limit, signal,
      ...(prepared.cache?.etag ? { etag: prepared.cache.etag } : {}),
      ...(prepared.cache?.last_modified ? { lastModified: prepared.cache.last_modified } : {}),
    });
    failures.push(...batch.failures);
    for (const [index, candidate] of batch.items.entries()) {
      try {
        const article = await normalizeArticle(candidate);
        const blocked = request.blockedDomains.some((domain) => article.sourceDomain === domain.toLowerCase() || article.sourceDomain.endsWith(`.${domain.toLowerCase()}`));
        const published = article.publishedAt ? Date.parse(article.publishedAt) : null;
        if (blocked || (published !== null && (published < request.since.getTime() || published > Date.parse(article.fetchedAt) + 300_000))) {
          filtered++; continue;
        }
        valid.push({ article, index });
      } catch { failures.push({ code: 'INVALID_NORMALIZED_ITEM', index }); }
    }
  } catch (error) {
    failures.push({ code: error instanceof RetrievalError ? error.code : 'PROVIDER_FAILURE' });
  }

  const finished = clock.now();
  // One transaction settles article/provenance/run/ledger together. On DB failure
  // the running run + unknown ledger remain as evidence; never blindly re-fetch it.
  return db.transaction(async (tx) => {
    let inserted = 0;
    let duplicates = 0;
    for (const { article, index } of valid) {
      const saved = await persistArticle(tx, article);
      if (saved.duplicate) duplicates++; else inserted++;
      await tx.query(`INSERT INTO article_retrievals(run_id,item_index,article_id,original_url,source_name,fetched_at,duplicate,raw_metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [request.runId, index, saved.id, article.originalUrl, article.source, article.fetchedAt, saved.duplicate, JSON.stringify(article.rawMetadata)]);
    }
    const cost = retriever.provider === 'rss' ? 0n : batch ? limits!.braveCostPerRequest : null;
    const status = !batch ? 'failed' : failures.length ? 'partial' : 'succeeded';
    await tx.query(`UPDATE retrieval_runs SET status=$2, finished_at=$3, number_fetched=$4, number_inserted=$5,
      number_duplicates=$6, number_filtered=$7, number_failures=$8, failures=$9::jsonb, not_modified=$10, estimated_cost_nanodollars=$11 WHERE id=$1`,
    [request.runId, status, finished.toISOString(), batch?.fetched ?? 0, inserted, duplicates, filtered, failures.length,
      JSON.stringify(failures), batch?.notModified ?? false, cost?.toString() ?? null]);
    if (request.source && batch) {
      await tx.query(`UPDATE sources SET etag=$2, last_modified=$3, last_fetched_at=$4, cache_key=$5 WHERE id=$1`,
        [request.source.id, batch.etag ?? (batch.notModified ? prepared.cache?.etag : null) ?? null,
          batch.lastModified ?? (batch.notModified ? prepared.cache?.last_modified : null) ?? null, finished.toISOString(), requestKey]);
    }
    if (retriever.provider === 'brave') {
      await tx.query(`UPDATE ai_usage SET status=$2, estimated_cost_nanodollars=$3, execution_time_ms=$4
        WHERE operation_id=$1 AND provider='brave' AND job_type='news_collection' AND attempt=1`,
      [request.runId, batch ? 'succeeded' : 'unknown', cost?.toString() ?? null, Math.max(0, finished.getTime() - started.getTime())]);
    }
    return (await tx.query<RunRecord>(selectRun, [request.runId])).rows[0]!;
  });
}
