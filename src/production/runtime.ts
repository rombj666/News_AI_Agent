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
import { drainInbox } from './inbox.js';
export function productionDatabases(config:ReturnType<typeof productionConfig>) {
  const runtime=neonDatabase(config.runtimeUrl,'news_runtime'),collector=neonDatabase(config.collectorUrl,'news_collector'),quality=neonDatabase(config.qualityUrl,'news_quality');
  return {runtime:runtime.db,collector:collector.db,quality:quality.db,
    close:async()=>{await Promise.all([runtime.close(),collector.close(),quality.close()]);}};
}
export async function productionReady(env:ProductionEnv) {
  const config=productionConfig(env),db=productionDatabases(config);
  try {
    for(const [telegramId,userId] of config.identities)await asUser(db.runtime,userId,async tx=>{
      const row=await tx.query(`SELECT u.id FROM users u JOIN user_preferences p ON p.user_id=u.id
        WHERE u.id=$1 AND u.telegram_user_id=$2 AND u.status='active'`,[userId,telegramId]);
      if(!row.rows.length)throw Error('PRODUCTION_IDENTITY_NOT_READY');
      await tx.query('SELECT update_id FROM telegram_webhook_inbox LIMIT 0');
    });
    await db.collector.query('SELECT id FROM scheduled_collection_batches LIMIT 0');
    await db.quality.query('SELECT id FROM quality_runs LIMIT 0');
    if(config.schedule)schedulingConfig({...env,RUN_LIVE_SCHEDULED_PIPELINE:'YES'});
  }finally{await db.close();}
}
export async function processInteractiveInbox(env:ProductionEnv,userIds?:readonly string[]) {
  const config=productionConfig(env),connection=neonDatabase(config.runtimeUrl,'news_runtime');
  try {
    const transport=new TelegramApi(config.telegram.token,fetch,1100,console.log);
    const model=config.telegram.aiEnabled?new OpenAIResponses(env):null;
    const router=createTelegramRouter({db:connection.db,botId:config.telegram.botId,identities:config.identities,transport,
      ai:model?{model,limits:config.telegram.limits!}:null,log:console.log});
    const selected=userIds??[...config.identities.values()];
    for(const userId of selected) {
      if(![...config.identities.values()].includes(userId))continue;
      await drainInbox(connection.db,userId,config.telegram.botId,raw=>router(raw),5,Date.now()+240000);
    }
  }finally{await connection.close();}
}
export async function productionTick(env:ProductionEnv,now=new Date()) {
  const config=productionConfig(env),deadline=Date.now()+10*60000;
  // Recovery of pending interactive updates runs with only the runtime role.
  // Its connection is fully closed before scheduled collection/generation begins.
  await processInteractiveInbox(env);
  if(!config.schedule)return;
  const db=productionDatabases(config);
  try {
    const transport=new TelegramApi(config.telegram.token,fetch,1100,console.log);
    const model=new OpenAIResponses(env);
    const schedule=schedulingConfig({...env,RUN_LIVE_SCHEDULED_PIPELINE:'YES'});
    const sources:CollectionSource[]=config.sources.map(source=>({retriever:new RssRetriever(source),request:{source,category:source.category,limit:30}}));
    if(schedule.braveQuery) {
      const brave=liveRetrievalConfig({...env,RUN_LIVE_RETRIEVAL:'YES',LIVE_RSS_SOURCE_ID:config.sources[0]!.id,LIVE_BRAVE_QUERY:schedule.braveQuery});
      sources.push({retriever:new BraveRetriever(brave.braveKey),request:{query:brave.query,category:'scheduled-public',limit:10},limits:brave.limits});
    }
    for(const [telegramId,userId] of config.identities) {
      if(Date.now()>=deadline)break;
      const result=await runScheduledPipeline({db:db.runtime,collector:db.collector,quality:db.quality,model,transport,
        botId:config.telegram.botId,sources,rankingLimits:schedule.rankingLimits,digestLimits:schedule.digestLimits,
        notifyEmpty:schedule.notifyEmpty,log:console.log},userId,telegramId,now);
      console.log(`PRODUCTION_SCHEDULE_RESULT: ${result.status}`);
    }
  }finally{await db.close();}
}
