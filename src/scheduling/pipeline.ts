import { asUser,type Database } from '../db/database.js';
import { systemClock,type Clock,type LanguageModel } from '../domain/ports.js';
import { readPreferences } from '../services/preferences.js';
import { occurrence } from './time.js';
import { sharedCollection,type CollectionSource } from './collection.js';
import { refreshQuality } from '../quality/service.js';
import { rankStories,fitRankingCandidates } from '../ai/ranking.js';
import { type ModelLimits } from '../ai/metered.js';
import { generateDigest } from '../digest/service.js';
import { ModelError } from '../ai/openai.js';
import { TelegramError,type TelegramDelivery } from '../adapters/telegram/types.js';
import { deliverScheduled } from './delivery.js';
import type { Digest } from '../digest/types.js';

export type PipelineDeps={db:Database;collector:Database;quality:Database;model:LanguageModel;transport:TelegramDelivery;
  botId:string;sources:CollectionSource[];rankingLimits:ModelLimits;digestLimits:ModelLimits;notifyEmpty?:boolean;clock?:Clock;log?:(code:string)=>void};
export async function runScheduledPipeline(deps:PipelineDeps,userId:string,telegramId:string,now=new Date(),manual=false,signal?:AbortSignal) {
  const {db}=deps;
  const clock=deps.clock??systemClock;
  const profile=await readPreferences(db,userId);
  const due=occurrence(now,profile.document,manual);
  if(!due) return {status:'not_due'};
  const type=profile.document.digestLength;
  const claim=await asUser(db,userId,async tx=>{
    const active=await tx.query("SELECT id FROM users WHERE id=$1 AND telegram_user_id=$2 AND status='active'",[userId,telegramId]);
    if(!active.rows.length) throw new ModelError('SCHEDULE_USER_NOT_ALLOWED');
    const current=(await tx.query<{version:number}>('SELECT version FROM user_preferences WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];
    if(current?.version!==profile.version) throw new ModelError('SCHEDULE_SETTINGS_CHANGED');
    const inserted=await tx.query<{id:string;ranking_id:string}>(`INSERT INTO scheduled_pipeline_runs(user_id,local_date,digest_type,scheduled_for,started_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id,ranking_id`,[userId,due.localDate,type,due.scheduledFor.toISOString(),now.toISOString()]);
    return inserted.rows[0];
  });
  if(!claim) return {status:'already_attempted'};
  let stage='retrieval';
  const update=async(fields:string,values:unknown[])=>asUser(db,userId,tx=>tx.query(`UPDATE scheduled_pipeline_runs SET ${fields} WHERE user_id=$1 AND id=$2`,[userId,claim.id,...values]));
  try {
    signal?.throwIfAborted();
    const retrieval=await sharedCollection(deps.collector,deps.sources,now,signal,clock);
    await update('retrieval_result=$3::jsonb',[JSON.stringify(retrieval)]);
    if(retrieval.some(r=>r.status==='running')) throw new ModelError('SHARED_COLLECTION_IN_PROGRESS');
    stage='quality';signal?.throwIfAborted();
    const quality=await refreshQuality(deps.quality,now);
    await update('candidate_count=$3',[quality.candidates.length]);
    if(!quality.candidates.length) {
      if(deps.notifyEmpty) {stage='delivery';await deliverScheduled(db,deps.transport,{userId,botId:deps.botId,chatId:telegramId,runId:claim.id,digest:null},now,signal,deps.log);}
      await update("status='no_fresh',completed_at=$3,delivery_status=$4",[clock.now().toISOString(),deps.notifyEmpty?'sent':'skipped']);
      return {status:'no_fresh',runId:claim.id};
    }
    // Reuse an already saved digest for this local date/type without reranking.
    const existing=await asUser(db,userId,async tx=>(await tx.query<{document:Digest}>(`SELECT document FROM digests WHERE user_id=$1 AND status='succeeded' AND digest_type=$2
      AND (generated_at AT TIME ZONE $3)::date=$4::date ORDER BY generated_at DESC LIMIT 1`,[userId,type,profile.document.timezone,due.localDate])).rows[0]?.document);
    let digest=existing??null;
    if(!digest) {
      stage='ranking';signal?.throwIfAborted();
      quality.candidates=fitRankingCandidates(quality.candidates,profile.document,deps.rankingLimits);
      await update("ranking_status='running'",[]);
      await rankStories(db,deps.model,userId,claim.ranking_id,quality,{...deps.rankingLimits,budgetScope:'job_type'},now);
      await update("ranking_status='succeeded'",[]);
      stage='digest';signal?.throwIfAborted();
      const result=await generateDigest(db,deps.model,{userId,operationId:claim.id,rankingOperationIds:[claim.ranking_id],
        periodStart:new Date(+now-86400000),periodEnd:now,type}, {...deps.digestLimits,budgetScope:'job_type'},{},now);
      digest=result.digest;
      if(!digest) {
        await update("status='no_fresh',completed_at=$3,delivery_status='skipped'",[clock.now().toISOString()]);
        return {status:'no_fresh',runId:claim.id};
      }
    } else await update("ranking_status='reused_digest'",[]);
    await update("digest_id=$3,delivery_status='sending'",[digest.id]);
    stage='delivery';signal?.throwIfAborted();
    if((await readPreferences(db,userId)).version!==profile.version) throw new ModelError('SCHEDULE_SETTINGS_CHANGED');
    await deliverScheduled(db,deps.transport,{userId,botId:deps.botId,chatId:telegramId,runId:claim.id,digest},now,signal,deps.log);
    await update("status='completed',delivery_status='sent',completed_at=$3",[clock.now().toISOString()]);
    return {status:'completed',runId:claim.id,digestId:digest.id};
  } catch(error) {
    if(stage==='digest') await update('digest_id=(SELECT id FROM digests WHERE user_id=$1 AND id=$2)',[]);
    const code=(error instanceof ModelError||error instanceof TelegramError)&&/^[A-Z0-9_]{1,80}$/.test(error.code)?error.code:signal?.aborted?'STOPPED':'STAGE_FAILED';
    const uncertain=stage==='delivery'&&code!=='TELEGRAM_DELIVERY_FAILED';
    await update('status=$3,failure_stage=$4,failure_code=$5,completed_at=$6,delivery_status=$7,ranking_status=CASE WHEN ranking_status=\'running\' THEN \'failed\' ELSE ranking_status END',
      [uncertain?'uncertain':'failed',stage,code,clock.now().toISOString(),stage==='delivery'?(uncertain?'uncertain':'failed'):'not_started']);
    return {status:uncertain?'uncertain':'failed',runId:claim.id,failureStage:stage,failureCode:code};
  }
}
