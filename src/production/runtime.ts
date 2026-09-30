import { neonDatabase } from '../db/neon.js';
import { asUser } from '../db/database.js';
import { productionConfig,type ProductionEnv } from './config.js';
import { TelegramApi } from '../adapters/telegram/api.js';
import { createTelegramRouter } from '../adapters/telegram/router.js';
import { OpenAIResponses } from '../ai/openai.js';
import { RssRetriever } from '../retrieval/rss.js';
import { BraveRetriever } from '../retrieval/brave.js';
import { liveRetrievalConfig } from '../retrieval/live-config.js';
import { schedulingConfig } from '../scheduling/config.js';
import { runScheduledPipeline } from '../scheduling/pipeline.js';
import type { CollectionSource } from '../scheduling/collection.js';
import { drainInbox,isNewsUpdate } from './inbox.js';
import type { Fetcher } from '../retrieval/http.js';
import { configuredNewsNow,newsNowConfig } from './news.js';
import { NewsNowError } from '../services/news-now.js';
import { BraveConfigError } from '../retrieval/brave-config.js';

const workerFetch:Fetcher=(url,init)=>globalThis.fetch(url,init);
export function productionDatabases(config:ReturnType<typeof productionConfig>) {
  const runtime=neonDatabase(config.runtimeUrl,'news_runtime'),collector=neonDatabase(config.collectorUrl,'news_collector'),quality=neonDatabase(config.qualityUrl,'news_quality');
  return {runtime:runtime.db,collector:collector.db,quality:quality.db,
    close:async()=>{await Promise.all([runtime.close(),collector.close(),quality.close()]);}};
}
// Readiness and execution must validate the same optional retrieval settings.
export function productionSchedulingConfig(env:ProductionEnv,config:ReturnType<typeof productionConfig>) {
  const schedule=schedulingConfig({...env,RUN_LIVE_SCHEDULED_PIPELINE:'YES'});
  const brave=schedule.braveQuery?liveRetrievalConfig({...env,RUN_LIVE_RETRIEVAL:'YES',
    LIVE_RSS_SOURCE_ID:config.sources[0]!.id,LIVE_BRAVE_QUERY:schedule.braveQuery}):null;
  return {...schedule,brave};
}
export async function productionReady(env:ProductionEnv,databases=productionDatabases) {
  const config=productionConfig(env);
  if(config.telegram.aiEnabled)newsNowConfig(env);
  if(config.schedule)productionSchedulingConfig(env,config);
  const db=databases(config);
  try {
    for(const [telegramId,userId] of config.identities)await asUser(db.runtime,userId,async tx=>{
      const row=await tx.query(`SELECT u.id FROM users u JOIN user_preferences p ON p.user_id=u.id
        WHERE u.id=$1 AND u.telegram_user_id=$2 AND u.status='active'`,[userId,telegramId]);
      if(!row.rows.length)throw Error('PRODUCTION_IDENTITY_NOT_READY');
      await tx.query('SELECT update_id FROM telegram_webhook_inbox LIMIT 0');
      await tx.query('SELECT id FROM news_now_runs LIMIT 0');
    });
    await db.collector.query('SELECT id FROM scheduled_collection_batches LIMIT 0');
    await db.quality.query('SELECT id FROM quality_runs LIMIT 0');
  }finally{await db.close();}
}
export async function processInteractiveInbox(env:ProductionEnv,userIds?:readonly string[],lightweightOnly=false) {
  const config=productionConfig(env),connection=neonDatabase(config.runtimeUrl,'news_runtime');
  try {
    const transport=new TelegramApi(config.telegram.token,workerFetch,1100,console.log);
    const model=config.telegram.aiEnabled?new OpenAIResponses(env):null;
    const router=createTelegramRouter({db:connection.db,botId:config.telegram.botId,identities:config.identities,transport,
      ai:model?{model,limits:config.telegram.limits!}:null,log:console.log,
      newsNow:async request=>{
        if(!model)throw new NewsNowError('LIVE_NEWS_AI_DISABLED','retrieval');
        try {newsNowConfig(env);}catch(error) {
          if(error instanceof BraveConfigError)console.log(`LIVE_NEWS_CONFIG_FIELDS: ${error.fields.join(',')}`);
          throw new NewsNowError('LIVE_NEWS_CONFIGURATION_INVALID','retrieval');
        }
        const databases=productionDatabases(config);
        try{return await configuredNewsNow(env,{...databases,runtime:connection.db},model,config.sources)(request);}
        finally{await databases.close();}
      }});
    const selected=userIds??[...config.identities.values()];
    for(const userId of selected) {
      if(![...config.identities.values()].includes(userId))continue;
      await drainInbox(connection.db,userId,config.telegram.botId,raw=>router(raw),lightweightOnly?1:5,
        Date.now()+(lightweightOnly?20000:240000),raw=>!lightweightOnly||!isNewsUpdate(raw));
    }
  }finally{await connection.close();}
}
export async function productionTick(env:ProductionEnv,now=new Date(),deps={
  processInbox:processInteractiveInbox,databases:productionDatabases,runPipeline:runScheduledPipeline,log:console.log,
}) {
  const config=productionConfig(env),deadline=Date.now()+10*60000;
  // Recovery of pending interactive updates runs with only the runtime role.
  // Its connection is fully closed before scheduled collection/generation begins.
  await deps.processInbox(env);
  if(!config.schedule)return;
  const schedule=productionSchedulingConfig(env,config);
  const db=deps.databases(config);
  try {
    const transport=new TelegramApi(config.telegram.token,workerFetch,1100,console.log);
    const model=new OpenAIResponses(env);
    const sources:CollectionSource[]=config.sources.map(source=>({retriever:new RssRetriever(source),request:{source,category:source.category,limit:30}}));
    if(schedule.brave) {
      const brave=schedule.brave;
      sources.push({retriever:new BraveRetriever(brave.braveKey),request:{query:brave.query,category:'scheduled-public',limit:10},limits:brave.limits});
    }
    for(const [telegramId,userId] of config.identities) {
      if(Date.now()>=deadline)break;
      const result=await deps.runPipeline({db:db.runtime,collector:db.collector,quality:db.quality,model,transport,
        botId:config.telegram.botId,sources,rankingLimits:schedule.rankingLimits,digestLimits:schedule.digestLimits,
        notifyEmpty:schedule.notifyEmpty,log:console.log},userId,telegramId,now);
      deps.log(`PRODUCTION_SCHEDULE_RESULT: ${result.status}`);
    }
  }finally{await db.close();}
}
