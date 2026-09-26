import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { localDatabase } from './local-db.js';
import { asUser } from '../src/db/database.js';
import { OpenAIResponses, ModelError } from '../src/ai/openai.js';
import { digestLiveConfig, DigestLiveConfigError } from '../src/digest/live-config.js';
import { generateDigest } from '../src/digest/service.js';
import { renderDigest } from '../src/digest/render.js';
import { formatUsd } from '../src/usage/pricing.js';

async function main() {
  const config = digestLiveConfig(process.env);
  const path = fileURLToPath(new URL('../.local/retrieval-live-db',import.meta.url));
  await access(path);
  const db = await localDatabase(path);
  try {
    const now = new Date();
    // Stable UTC calendar period ensures repeated invocations use the same key.
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
    const periodEnd = new Date(+periodStart + 86400000);
    const jobs = await asUser(db.runtime,config.userId,tx => tx.query<{id:string}>(`SELECT id FROM job_runs
      WHERE user_id=$1 AND job_type='news_ranking' AND status='succeeded' ORDER BY updated_at DESC,id LIMIT 10`,[config.userId]));
    const result = await generateDigest(db.runtime,new OpenAIResponses(process.env),{userId:config.userId,
      operationId:crypto.randomUUID(),rankingOperationIds:jobs.rows.map(row => row.id),periodStart,periodEnd,type:'normal',force:config.force},
    config.limits,{maxStories:3},now);
    if (!result.digest) { console.log('NO_ELIGIBLE_RANKED_STORIES: no model request; refresh and rank separately.'); return; }
    const digest = result.digest;
    const usage = await asUser(db.runtime,config.userId,tx => tx.query<{input_tokens:number|null;output_tokens:number|null;
      cached_input_tokens:number|null;estimated_cost_nanodollars:string|null;execution_time_ms:number;status:string}>(
      `SELECT input_tokens,output_tokens,cached_input_tokens,estimated_cost_nanodollars::text,execution_time_ms,status
       FROM ai_usage WHERE user_id=$1 AND operation_id=$2 AND job_type='news_digest'`,[config.userId,digest.id]));
    const row = usage.rows[0];
    console.log(JSON.stringify({digestId:digest.id,model:digest.model,inputStories:digest.inputStoryCount,outputStories:digest.outputStoryCount,
      sections:digest.sections.map(s => s.name),replayed:result.replayed,usage:row,
      estimatedCost:row?.estimated_cost_nanodollars == null ? 'unknown' : formatUsd(BigInt(row.estimated_cost_nanodollars))}));
    console.log(renderDigest(digest));
    console.log('Digest saved locally. No retrieval, delivery, or scheduled work.');
  } finally { await db.close(); }
}
main().catch(error => {
  console.error(error instanceof DigestLiveConfigError ? error.message
    : error instanceof ModelError && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'DIGEST_LOCAL_SETUP_OR_DATABASE_ERROR');
  process.exitCode = 1;
});
