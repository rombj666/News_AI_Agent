import { access,readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { localDatabase } from './local-db.js';
import { withTelegramLock,safeTelegramError } from './telegram-common.js';
import { telegramConfig } from '../src/adapters/telegram/config.js';
import { schedulingConfig,ScheduleConfigError } from '../src/scheduling/config.js';
import { existingTelegramUser } from '../src/services/telegram-digest.js';
import { OpenAIResponses,ModelError } from '../src/ai/openai.js';
import { TelegramApi,abortableDelay } from '../src/adapters/telegram/api.js';
import { pollTelegram,setupTelegramCommands } from '../src/adapters/telegram/polling.js';
import { createTelegramRouter } from '../src/adapters/telegram/router.js';
import { runScheduledPipeline,type PipelineDeps } from '../src/scheduling/pipeline.js';
import { parseRssSources } from '../src/retrieval/sources.js';
import { RssRetriever } from '../src/retrieval/rss.js';
import { BraveRetriever } from '../src/retrieval/brave.js';
import { liveRetrievalConfig } from '../src/retrieval/live-config.js';
import type { CollectionSource } from '../src/scheduling/collection.js';
import { asUser } from '../src/db/database.js';

async function main() {
  const continuous=process.argv.includes('--continuous');
  if(process.argv.slice(2).some(a=>a!=='--continuous')) throw new ModelError('UNSUPPORTED_ARGUMENT');
  const config=schedulingConfig(process.env);
  const telegram=telegramConfig(process.env,'dev');
  const feeds=parseRssSources(JSON.parse(await readFile(new URL('../config/rss-sources.json',import.meta.url),'utf8'))).filter(s=>s.enabled);
  if(feeds.length>5) throw new ModelError('SCHEDULE_FEED_LIMIT');
  const sources:CollectionSource[]=feeds.map(source=>({retriever:new RssRetriever(source),request:{source,category:source.category,limit:30}}));
  if(config.braveQuery) {
    const brave=liveRetrievalConfig({...process.env,RUN_LIVE_RETRIEVAL:'YES',LIVE_RSS_SOURCE_ID:feeds[0]?.id??'unused',LIVE_BRAVE_QUERY:config.braveQuery});
    sources.push({retriever:new BraveRetriever(brave.braveKey),request:{query:config.braveQuery,category:'scheduled-public',limit:10},limits:brave.limits});
  }
  if(!sources.length) throw new ModelError('SCHEDULE_NO_RETRIEVAL_SOURCES');
  await withTelegramLock(telegram.botId,async externalSignal=>{
    const path=fileURLToPath(new URL('../.local/retrieval-live-db',import.meta.url));await access(path);
    const db=await localDatabase(path);
    const controller=new AbortController();
    const signal=AbortSignal.any([externalSignal,controller.signal]);
    let polling:Promise<void>|undefined;
    try {
      const identities=new Map<string,string>();
      for(const id of continuous?telegram.allowedIds:[process.env.LIVE_TELEGRAM_USER_ID?.trim()||(telegram.allowedIds.length===1?telegram.allowedIds[0]:'')!]) {
        const identity=await existingTelegramUser(db.owner,telegram.allowedIds,id);
        identities.set(identity.telegramId,identity.userId);
      }
      const model=new OpenAIResponses(process.env),transport=new TelegramApi(telegram.token,fetch,1100,console.log);
      await setupTelegramCommands(transport,signal,console.log);
      const deps:PipelineDeps={db:db.runtime,collector:db.collector,quality:db.quality,model,transport,botId:telegram.botId,sources,
        rankingLimits:config.rankingLimits,digestLimits:config.digestLimits,notifyEmpty:config.notifyEmpty,log:console.log};
      let pollingFailed=false;
      if(continuous) {
        const router=createTelegramRouter({db:db.runtime,botId:telegram.botId,identities,transport,
          ai:telegram.aiEnabled?{model,limits:telegram.limits!}:null,log:console.log});
        polling=pollTelegram(transport,async update=>{await router(update,signal);},signal,console.log)
          .catch(()=>{pollingFailed=true;controller.abort();console.error('SCHEDULER_POLLING_FAILED');});
        console.log('LOCAL_SCHEDULER_AND_TELEGRAM_STARTED');
      }
      do {
        for(const [telegramId,userId] of identities) {
          if(signal.aborted) break;
          const result=await runScheduledPipeline(deps,userId,telegramId,new Date(),!continuous,signal);
          if(result.status!=='not_due'&&result.status!=='already_attempted') console.log(JSON.stringify({userId,...result}));
          if(!continuous) {
            if(['failed','uncertain'].includes(result.status)) process.exitCode=1;
            if(result.status==='already_attempted') console.log('SCHEDULE_ALREADY_ATTEMPTED_FOR_LOCAL_DATE');
            const stages=await asUser(db.runtime,userId,tx=>tx.query(`SELECT id,scheduled_for,status,retrieval_result,candidate_count,ranking_status,digest_id,delivery_status,failure_stage,failure_code
              FROM scheduled_pipeline_runs WHERE user_id=$1 ORDER BY started_at DESC LIMIT 1`,[userId]));
            console.log(JSON.stringify({stages:stages.rows[0]}));
            const usage=await asUser(db.runtime,userId,tx=>tx.query(`SELECT job_type,status,estimated_cost_nanodollars::text,input_tokens,output_tokens
              FROM ai_usage WHERE user_id=$1 AND operation_id IN (SELECT ranking_id FROM scheduled_pipeline_runs WHERE user_id=$1 UNION SELECT digest_id FROM scheduled_pipeline_runs WHERE user_id=$1)
              ORDER BY created_at DESC LIMIT 4`,[userId]));
            console.log(JSON.stringify({usage:usage.rows}));
          }
        }
        if(!continuous||signal.aborted) break;
        try {await abortableDelay(config.intervalMs,signal);} catch {if(!signal.aborted) throw new Error('SCHEDULER_WAIT_FAILED');}
      } while(!signal.aborted);
      if(pollingFailed) process.exitCode=1;
    } finally {controller.abort();await polling;await db.close();}
  });
}
main().catch(error=>{console.error(error instanceof ScheduleConfigError?error.message:error instanceof ModelError?error.code:safeTelegramError(error));process.exitCode=1;});
