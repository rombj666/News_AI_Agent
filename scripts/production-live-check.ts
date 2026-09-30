import { neonConfig } from '@neondatabase/serverless';
import WebSocket from 'ws';
import { productionEnv } from './production-env.js';
import { productionPreflight } from '../src/production/preflight.js';
import { productionConfig } from '../src/production/config.js';
import { productionDatabases } from '../src/production/runtime.js';
import { newsNowConfig } from '../src/production/news.js';
import { runLiveChecks,liveCheckCode } from '../src/production/live-check.js';
import { asUser } from '../src/db/database.js';
import { ModelError,OpenAIResponses } from '../src/ai/openai.js';
import { rankStories,fitRankingCandidates } from '../src/ai/ranking.js';
import { generateDigest } from '../src/digest/service.js';
import type { Digest } from '../src/digest/types.js';
import { collectNews } from '../src/retrieval/collect.js';
import { BraveRetriever } from '../src/retrieval/brave.js';
import { RssRetriever } from '../src/retrieval/rss.js';
import { refreshQuality } from '../src/quality/service.js';
import { TelegramApi } from '../src/adapters/telegram/api.js';
import { telegramConfig } from '../src/adapters/telegram/config.js';
import { respondToNews } from '../src/services/news-assistant.js';
import { readPreferences,decideProposal } from '../src/services/preferences.js';

async function main() {
  // The gate precedes DB construction and all provider calls. Never run by tests.
  if(process.env.RUN_LIVE_PRODUCTION_CHECK!=='YES')throw new ModelError('RUN_LIVE_PRODUCTION_CHECK_REQUIRED');
  const env=await productionEnv(),checks=productionPreflight(env);
  for(const r of checks)console.log(`${r.name} ${r.fields.length?'FAIL '+r.fields.join(','):'PASS'}`);
  if(checks.some(r=>r.fields.length)){process.exitCode=1;return;}
  const query=env.LIVE_PRODUCTION_QUERY?.trim();
  if(!query||query.length>400||query.split(/\s+/).length>50)throw new ModelError('LIVE_PRODUCTION_QUERY_REQUIRED');
  const config=productionConfig(env),news=newsNowConfig(env);
  const userId=env.LIVE_PRODUCTION_USER_ID??(config.identities.size===1?[...config.identities.values()][0]:undefined);
  if(!userId||![...config.identities.values()].includes(userId))throw new ModelError('LIVE_PRODUCTION_USER_ID_REQUIRED');
  neonConfig.webSocketConstructor=WebSocket;
  const db=productionDatabases(config),now=new Date(),model=new OpenAIResponses(env);
  const ai={model,limits:telegramConfig({...env,TELEGRAM_AI_ENABLED:'YES'},'dev').limits!};
  let braveRunId:string|undefined,quality:Awaited<ReturnType<typeof refreshQuality>>|undefined,digest:Digest|null=null;
  const rankingId=crypto.randomUUID();
  const reports:string[]=[];
  try {
    const passed=await runLiveChecks(env.RUN_LIVE_PRODUCTION_CHECK,[
      {name:'NEON_RUNTIME',run:()=>asUser(db.runtime,userId,async tx=>{
        const row=await tx.query('SELECT id FROM users WHERE id=$1 AND status=\'active\'',[userId]);
        if(!row.rows.length)throw new ModelError('PRODUCTION_IDENTITY_NOT_READY');
        await tx.query('SELECT id FROM news_now_runs LIMIT 0');await tx.query('SELECT version FROM user_preferences WHERE user_id=$1',[userId]);
      })},
      {name:'NEON_COLLECTOR',run:()=>db.collector.query('SELECT id FROM retrieval_runs LIMIT 0')},
      {name:'NEON_QUALITY',run:()=>db.quality.query('SELECT id FROM quality_runs LIMIT 0')},
      {name:'TELEGRAM_API',run:()=>new TelegramApi(config.telegram.token).inspectConnection()},
      {name:'BRAVE_NEWS_SEARCH',run:async()=>{
        const run=await collectNews(db.collector,new BraveRetriever(news.brave.key),{runId:crypto.randomUUID(),userId,query,
          category:'production-verification',since:new Date(+now-86400000),limit:3},{limits:news.brave.limits});
        if(run.status==='failed'||run.status==='partial')throw new ModelError(`BRAVE_${/^[A-Z0-9_]{1,60}$/.test(run.failures[0]?.code??'')?run.failures[0]!.code:'RESPONSE_INVALID'}`);
        braveRunId=run.id;
      }},
      {name:'RSS',run:async()=>{
        const source=config.sources[0]!;
        const run=await collectNews(db.collector,new RssRetriever(source),{runId:crypto.randomUUID(),source,category:source.category,
          since:new Date(+now-86400000),limit:10});
        if(run.status==='failed'||run.status==='partial')throw new ModelError('RSS_RETRIEVAL_FAILED');
      }},
      {name:'OPENAI_RANKING',run:async()=>{
        if(!braveRunId)throw new ModelError('BRAVE_NOT_READY');
        quality=await refreshQuality(db.quality,now,{allowPageAge:true});
        const rows=await asUser(db.runtime,userId,tx=>tx.query<{article_id:string}>('SELECT article_id FROM article_retrievals WHERE run_id=$1',[braveRunId]));
        const ids=new Set(rows.rows.map(r=>r.article_id));
        quality.candidates=quality.candidates.filter(c=>c.sources.some(s=>ids.has(s.articleId)));
        if(!quality.candidates.length)throw new ModelError('NO_FRESH_CANDIDATES');
        quality.candidates=fitRankingCandidates(quality.candidates,(await readPreferences(db.runtime,userId)).document,news.rankingLimits,3,query);
        await rankStories(db.runtime,model,userId,rankingId,quality,news.rankingLimits,now,{quality:{allowPageAge:true},requestTopic:query});
      }},
      {name:'OPENAI_DIGEST',run:async()=>{
        const result=await generateDigest(db.runtime,model,{userId,operationId:crypto.randomUUID(),rankingOperationIds:[rankingId],
          periodStart:new Date(+now-86400000),periodEnd:now,type:'quick',allowPageAge:true,force:true,purpose:'current_question'},news.digestLimits,{},now);
        digest=result.digest;if(!digest)throw new ModelError('NO_ELIGIBLE_RANKED_STORIES');
      }},
      {name:'OPENAI_EXPLANATION',run:async()=>{
        if(!digest)throw new ModelError('DIGEST_NOT_READY');
        await respondToNews(db.runtime,{userId,operationId:crypto.randomUUID(),action:{kind:'explain',digestId:digest.id,position:1}},ai,now);
      }},
      {name:'OPENAI_PREFERENCE',run:async()=>{
        // Clarification exercises interpretation without proposing/saving settings.
        const reply=await respondToNews(db.runtime,{userId,operationId:crypto.randomUUID(),text:'Change my preferred news language; ask me which language.'},ai,now);
        if(reply.kind==='proposal')await decideProposal(db.runtime,userId,reply.proposalId,'cancel');
      }},
    ],line=>{reports.push(line);console.log(line);});
    console.log(`OPENAI_LUNA ${['RANKING','DIGEST','EXPLANATION','PREFERENCE'].every(name=>reports.includes(`OPENAI_${name} PASS`))?'PASS':'FAIL SEE_INTEGRATION_RESULTS'}`);
    if(!passed)process.exitCode=1;
  }finally{await db.close();}
}
main().catch(error=>{console.error(`PRODUCTION_LIVE_CHECK FAIL ${liveCheckCode(error)}`);process.exitCode=1;});
