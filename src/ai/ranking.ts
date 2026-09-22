import { z } from 'zod';
import type { Database } from '../db/database.js';
import { asUser } from '../db/database.js';
import { preferencesSchema, uuidSchema } from '../domain/preferences.js';
import type { LanguageModel } from '../domain/ports.js';
import { LUNA_MODEL } from '../config/index.js';
import { qualityConfigSchema } from '../quality/config.js';
import { freshness } from '../quality/freshness.js';
import type { StoryCandidate } from '../quality/types.js';
import { recordUsageInTransaction } from '../usage/ledger.js';
import { estimateLunaCost, LUNA_TEXT_RATES } from '../usage/pricing.js';
import { ModelError } from './openai.js';
import { rankingInstructions, rankingJsonSchema, rankingOutputSchema, type Classification } from './ranking-schema.js';

const limitsSchema=z.object({maxInputTokens:z.number().int().min(1024).max(100000).default(12000),
  maxOutputTokens:z.number().int().min(128).max(16000).default(2000),
  timeoutMs:z.number().int().min(1).max(60000).default(30000),
  monthlyBudgetNanodollars:z.bigint().positive().max(9_000_000_000_000n),
}).strict();
export type RankingLimits=z.input<typeof limitsSchema>;
export type QualityInput={runId:string;candidates:StoryCandidate[]};
type Reply=Awaited<ReturnType<LanguageModel['generate']>>;
const fail=(code:string):never=>{throw new ModelError(code);};
export async function rankStories(db:Database,model:LanguageModel,userId:string,operationId:string,
  quality:QualityInput,rawLimits:RankingLimits,now=new Date()) {
  uuidSchema.parse(userId);uuidSchema.parse(operationId);uuidSchema.parse(quality.runId);
  const limits=limitsSchema.parse(rawLimits);
  if(model.model!==LUNA_MODEL) fail('MODEL_NOT_ALLOWED');
  if(!Number.isFinite(now.getTime())) fail('RANKING_TIME_INVALID');
  const candidates=quality.candidates;
  if(candidates.length===0) return {stories:[],replayed:false};
  if(candidates.length>20 || new Set(candidates.map(c=>c.clusterId)).size!==candidates.length) fail('CANDIDATE_LIMIT_OR_DUPLICATE');
  const config=qualityConfigSchema.parse({});
  for(const c of candidates) {
    if(freshness(c.representative,now,config)!=='fresh') fail('CANDIDATE_NOT_FRESH');
  }
  const prefs=await asUser(db,userId,async tx=>{
    const result=await tx.query<{document:unknown}>(`SELECT p.document FROM user_preferences p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1 AND u.status='active'`,[userId]);
    if(!result.rows[0]) fail('RANKING_USER_NOT_READY');
    return preferencesSchema.parse(result.rows[0]!.document);
  });
  // Verify the supplied candidates belong to the active persisted quality snapshot.
  for(const c of candidates) {
    const result=await db.query(`SELECT id FROM story_clusters WHERE id=$1 AND quality_run_id=$2 AND representative_article_id=$3 AND active=true`,[c.clusterId,quality.runId,c.representative.id]);
    if(!result.rows.length) fail('QUALITY_SNAPSHOT_STALE');
  }
  const context=JSON.stringify({preferences:{topics:prefs.topics,regions:prefs.regions,sources:prefs.sources,exclusions:prefs.exclusions},
    stories:candidates.map(c=>({clusterId:c.clusterId,title:c.title.slice(0,500),description:c.representative.description.slice(0,1600),
      publishedAt:c.representative.publishedAt,source:c.representative.sourceDomain,sourceCount:c.sourceCount}))});
  // UTF-8 byte count plus framing allowance is intentionally conservative, not a tokenizer estimate.
  const inputBound=new TextEncoder().encode(rankingInstructions+context+JSON.stringify(rankingJsonSchema)).length+1024;
  if(inputBound>limits.maxInputTokens) fail('INPUT_TOKEN_LIMIT');
  const keyBytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({context,qualityRun:quality.runId,model:model.model,limits:{...limits,monthlyBudgetNanodollars:limits.monthlyBudgetNanodollars.toString()}})));
  const key=Array.from(new Uint8Array(keyBytes),x=>x.toString(16).padStart(2,'0')).join('');
  // Reserve conservatively including possible cache-write uplift. No cache savings assumed.
  const reserve=BigInt(limits.maxInputTokens)*250n+BigInt(limits.maxOutputTokens)*1200n;
  const previous=await asUser(db,userId,async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(74102922)');
    const prior=await tx.query<{status:string;request_key:string;result:unknown}>(`SELECT status,request_key,result FROM job_runs WHERE id=$1 AND user_id=$2`,[operationId,userId]);
    if(prior.rows[0]) {
      if(prior.rows[0].request_key!==key) fail('RANKING_OPERATION_CONFLICT');
      if(prior.rows[0].status!=='succeeded') fail('RANKING_OPERATION_ALREADY_ATTEMPTED');
      return rankingOutputSchema.parse(prior.rows[0].result).stories;
    }
    const month=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1));
    const end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1));
    const totals=await tx.query<{held:string;unknown:number}>(`SELECT COALESCE(SUM(COALESCE(estimated_cost_nanodollars,reserved_cost_nanodollars)),0)::text AS held,
      COUNT(*) FILTER(WHERE estimated_cost_nanodollars IS NULL AND reserved_cost_nanodollars=0)::integer AS unknown
      FROM ai_usage WHERE user_id=$1 AND created_at >= $2 AND created_at < $3`,[userId,month.toISOString(),end.toISOString()]);
    if(totals.rows[0]!.unknown>0 || BigInt(totals.rows[0]!.held)+reserve>limits.monthlyBudgetNanodollars) fail('RANKING_BUDGET_EXCEEDED');
    await tx.query(`INSERT INTO job_runs(id,user_id,job_type,occurrence_key,status,attempts,request_key,created_at,updated_at)
      VALUES($1::uuid,$2,'news_ranking',$1::text,'running',1,$3,$4,$4)`,[operationId,userId,key,now.toISOString()]);
    await recordUsageInTransaction(tx,userId,{operationId,attempt:1,provider:'openai',model:LUNA_MODEL,jobType:'news_ranking',requestId:null,
      status:'unknown',inputTokens:null,cachedInputTokens:null,outputTokens:null,searchCalls:0,estimatedCostNanodollars:null,
      rateSnapshot:{version:LUNA_TEXT_RATES.version,inputPerToken:'200',cachedInputPerToken:'20',outputPerToken:'1200'},executionTimeMs:0,createdAt:now});
    await tx.query(`UPDATE ai_usage SET reserved_cost_nanodollars=$3 WHERE user_id=$1 AND operation_id=$2 AND provider='openai'`,[userId,operationId,reserve.toString()]);
    return null;
  });
  if(previous) return {stories:attach(previous,candidates),replayed:true};
  const started=Date.now();let reply:Reply|null=null;let output:Classification[]|null=null;let errorCode:string|null=null;
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ModelError('MODEL_TIMEOUT'));},limits.timeoutMs);});
    reply=await Promise.race([model.generate({instructions:rankingInstructions,context,maxOutputTokens:limits.maxOutputTokens,
      responseSchema:rankingJsonSchema,signal:controller.signal}),timeout]);
    if(reply.usage && (reply.usage.inputTokens>limits.maxInputTokens || reply.usage.outputTokens>limits.maxOutputTokens)) fail('PROVIDER_TOKEN_LIMIT_EXCEEDED');
    const parsed=rankingOutputSchema.safeParse(JSON.parse(reply.text));
    if(!parsed.success) throw new ModelError('MODEL_OUTPUT_INVALID');
    const ids=new Set(parsed.data.stories.map(s=>s.clusterId));
    if(ids.size!==candidates.length || parsed.data.stories.length!==candidates.length || candidates.some(c=>!ids.has(c.clusterId))) fail('MODEL_CLUSTER_IDS_INVALID');
    output=parsed.data.stories;
  } catch(error) {
    if(error instanceof ModelError) {errorCode=error.code;reply=error.reply??reply;}
    else errorCode='MODEL_OUTPUT_OR_PROVIDER_ERROR';
  } finally {if(timer) clearTimeout(timer);}
  const usage=reply?.usage??null;
  let cost:bigint|null=null;
  if(usage && usage.cachedInputTokens!==null) {
    try {cost=estimateLunaCost({...usage,cachedInputTokens:usage.cachedInputTokens});} catch {errorCode='MODEL_USAGE_INVALID';output=null;}
  }
  await asUser(db,userId,async tx=>{
    await tx.query(`UPDATE ai_usage SET status=$3,input_tokens=$4,cached_input_tokens=$5,output_tokens=$6,
      estimated_cost_nanodollars=$7,execution_time_ms=$8,request_id=$9,error_code=$10
      WHERE user_id=$1 AND operation_id=$2 AND provider='openai' AND attempt=1`,
      [userId,operationId,cost===null?'unknown':errorCode?'failed':'succeeded',usage?.inputTokens??null,usage?.cachedInputTokens??null,
        usage?.outputTokens??null,cost?.toString()??null,Math.max(0,Date.now()-started),reply?.requestId??null,errorCode]);
    await tx.query(`UPDATE job_runs SET status=$3,result=$4::jsonb,error_code=$5,updated_at=now() WHERE user_id=$1 AND id=$2`,
      [userId,operationId,errorCode?'failed':'succeeded',output?JSON.stringify({stories:output}):null,errorCode]);
  });
  if(errorCode) fail(errorCode);
  return {stories:attach(output!,candidates),replayed:false};
}
function attach(stories:Classification[],candidates:StoryCandidate[]) {
  return stories.map(classification=>({classification,candidate:candidates.find(c=>c.clusterId===classification.clusterId)!,
    score:Math.round((classification.userRelevanceScore*0.6+classification.importanceScore*0.4)*100)/100}))
    .sort((a,b)=>b.score-a.score || b.classification.confidence-a.classification.confidence || a.classification.clusterId.localeCompare(b.classification.clusterId));
}
