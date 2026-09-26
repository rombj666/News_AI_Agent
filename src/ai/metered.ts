import { z } from 'zod';
import { asUser, type Database, type Queryable } from '../db/database.js';
import { uuidSchema } from '../domain/preferences.js';
import type { LanguageModel } from '../domain/ports.js';
import { LUNA_MODEL } from '../config/index.js';
import { recordUsageInTransaction } from '../usage/ledger.js';
import { estimateLunaCost, LUNA_TEXT_RATES } from '../usage/pricing.js';
import { ModelError } from './openai.js';

export const modelLimitsSchema = z.object({
  maxInputTokens: z.number().int().min(1024).max(100000).default(12000),
  maxOutputTokens: z.number().int().min(128).max(16000).default(2000),
  timeoutMs: z.number().int().min(1).max(60000).default(30000),
  monthlyBudgetNanodollars: z.bigint().positive().max(9_000_000_000_000n),
  budgetScope: z.enum(['all','job_type','conversation']).default('all'),
}).strict();
export type ModelLimits = z.input<typeof modelLimitsSchema>;
export const modelInputBound = (instructions: string, context: string, schema: Record<string, unknown>) =>
  new TextEncoder().encode(instructions + context + JSON.stringify(schema)).length + 1024;
export async function requestHash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
}

// Shared write-ahead reservation and settlement for ranking and digest generation.
// Hooks run inside the same transactions as job/ledger state, never around network I/O.
export async function runModelJob<T>(db: Database, model: LanguageModel, request: {
  userId: string; operationId: string; jobType: 'news_ranking' | 'news_digest' | 'news_explanation' | 'preference_interpretation'; key: string;
  instructions: string; context: string; schema: Record<string, unknown>; limits: ModelLimits; now: Date;
  parse: (value: unknown) => T;
  reserve?: (tx: Queryable) => Promise<void>;
  settle?: (tx: Queryable, output: T | null, error: string | null) => Promise<void>;
}) {
  const { userId, operationId, jobType, now } = request;
  uuidSchema.parse(userId); uuidSchema.parse(operationId);
  const limits = modelLimitsSchema.parse(request.limits);
  const prefix = {news_ranking:'RANKING',news_digest:'DIGEST',news_explanation:'EXPLANATION',preference_interpretation:'PREFERENCE'}[jobType];
  if (model.model !== LUNA_MODEL) throw new ModelError('MODEL_NOT_ALLOWED');
  if (!Number.isFinite(now.getTime())) throw new ModelError('MODEL_TIME_INVALID');
  if (modelInputBound(request.instructions, request.context, request.schema) > limits.maxInputTokens) throw new ModelError('INPUT_TOKEN_LIMIT');
  const reserve = BigInt(limits.maxInputTokens) * 250n + BigInt(limits.maxOutputTokens) * 1200n;
  const previous = await asUser(db, userId, async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(74102922)');
    const prior = await tx.query<{ status: string; request_key: string; result: unknown; job_type: string }>(
      'SELECT status,request_key,result,job_type FROM job_runs WHERE id=$1 AND user_id=$2', [operationId,userId]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_key !== request.key || prior.rows[0].job_type !== jobType) throw new ModelError(`${prefix}_OPERATION_CONFLICT`);
      if (prior.rows[0].status !== 'succeeded') throw new ModelError(`${prefix}_OPERATION_ALREADY_ATTEMPTED`);
      return { output: request.parse(prior.rows[0].result) };
    }
    const month = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1));
    const end = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1));
    const totals = await tx.query<{ held: string; unknown: number }>(`SELECT COALESCE(SUM(COALESCE(estimated_cost_nanodollars,reserved_cost_nanodollars)),0)::text AS held,
      COUNT(*) FILTER(WHERE estimated_cost_nanodollars IS NULL AND reserved_cost_nanodollars=0)::integer AS unknown
      FROM ai_usage WHERE user_id=$1 AND created_at >= $2 AND created_at < $3
      AND ($4='all' OR ($4='job_type' AND job_type=$5) OR ($4='conversation' AND job_type IN ('news_explanation','preference_interpretation')))`,
      [userId,month.toISOString(),end.toISOString(),limits.budgetScope,jobType]);
    if (totals.rows[0]!.unknown > 0 || BigInt(totals.rows[0]!.held) + reserve > limits.monthlyBudgetNanodollars) throw new ModelError(`${prefix}_BUDGET_EXCEEDED`);
    await tx.query(`INSERT INTO job_runs(id,user_id,job_type,occurrence_key,status,attempts,request_key,created_at,updated_at)
      VALUES($1::uuid,$2,$3,$1::text,'running',1,$4,$5,$5)`, [operationId,userId,jobType,request.key,now.toISOString()]);
    await request.reserve?.(tx);
    await recordUsageInTransaction(tx,userId,{ operationId,attempt:1,provider:'openai',model:LUNA_MODEL,jobType,requestId:null,
      status:'unknown',inputTokens:null,cachedInputTokens:null,outputTokens:null,searchCalls:0,estimatedCostNanodollars:null,
      rateSnapshot:{version:LUNA_TEXT_RATES.version,inputPerToken:'200',cachedInputPerToken:'20',outputPerToken:'1200'},executionTimeMs:0,createdAt:now });
    await tx.query(`UPDATE ai_usage SET reserved_cost_nanodollars=$3 WHERE user_id=$1 AND operation_id=$2 AND provider='openai'`, [userId,operationId,reserve.toString()]);
    return null;
  });
  if (previous) return { output: previous.output, replayed: true };
  const started = Date.now();
  let reply: Awaited<ReturnType<LanguageModel['generate']>> | null = null;
  let output: T | null = null;
  let errorCode: string | null = null;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_,reject) => { timer = setTimeout(() => { controller.abort(); reject(new ModelError('MODEL_TIMEOUT')); },limits.timeoutMs); });
    reply = await Promise.race([model.generate({ instructions:request.instructions,context:request.context,
      maxOutputTokens:limits.maxOutputTokens,responseSchema:request.schema,signal:controller.signal }),timeout]);
    if (reply.usage && (reply.usage.inputTokens > limits.maxInputTokens || reply.usage.outputTokens > limits.maxOutputTokens)) throw new ModelError('PROVIDER_TOKEN_LIMIT_EXCEEDED');
    output = request.parse(JSON.parse(reply.text));
  } catch (error) {
    if (error instanceof ModelError) { errorCode = /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'MODEL_PROVIDER_ERROR'; reply = error.reply ?? reply; }
    else errorCode = 'MODEL_OUTPUT_OR_PROVIDER_ERROR';
    output = null;
  } finally { if (timer) clearTimeout(timer); }
  const usage = reply?.usage ?? null;
  let cost: bigint | null = null;
  if (usage && usage.cachedInputTokens !== null) {
    try { cost = estimateLunaCost({...usage,cachedInputTokens:usage.cachedInputTokens}); }
    catch { errorCode = 'MODEL_USAGE_INVALID'; output = null; }
  }
  await asUser(db,userId,async tx => {
    await tx.query(`UPDATE ai_usage SET status=$3,input_tokens=$4,cached_input_tokens=$5,output_tokens=$6,
      estimated_cost_nanodollars=$7,execution_time_ms=$8,request_id=$9,error_code=$10
      WHERE user_id=$1 AND operation_id=$2 AND provider='openai' AND attempt=1`,
    [userId,operationId,cost===null?'unknown':errorCode?'failed':'succeeded',usage?.inputTokens??null,usage?.cachedInputTokens??null,
      usage?.outputTokens??null,cost?.toString()??null,Math.max(0,Date.now()-started),reply?.requestId??null,errorCode]);
    await tx.query(`UPDATE job_runs SET status=$3,result=$4::jsonb,error_code=$5,updated_at=$6 WHERE user_id=$1 AND id=$2`,
      [userId,operationId,errorCode?'failed':'succeeded',output===null?null:JSON.stringify(output),errorCode,now.toISOString()]);
    await request.settle?.(tx,output,errorCode);
  });
  // A failed settlement leaves the original unknown reservation and running job
  // intact. Never automatically repeat a potentially billed call.
  if (errorCode) throw new ModelError(errorCode);
  return { output: output!, replayed: false };
}
