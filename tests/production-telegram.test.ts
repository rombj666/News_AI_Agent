import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorker } from '../src/entrypoints/worker.js';
import { pooledDatabase,type TransactionPool } from '../src/db/neon.js';
import { productionReady,productionTick } from '../src/production/runtime.js';
import type { Database } from '../src/db/database.js';
import { productionPreflight } from '../src/production/preflight.js';
import { runLiveChecks } from '../src/production/live-check.js';
import { ModelError } from '../src/ai/openai.js';

const token='123456:abcdefghijklmnopqrstuvwxyz0123456789',secret='s'.repeat(32);
const userId='11111111-1111-4111-8111-111111111111';
const productionEnv={PRODUCTION_HEALTH_SECRET:secret,TELEGRAM_WEBHOOK_SECRET:'w'.repeat(32),TELEGRAM_BOT_TOKEN:token,
  TELEGRAM_ALLOWED_USER_IDS:'12345',TELEGRAM_USER_MAP:JSON.stringify({'12345':userId}),TELEGRAM_AI_ENABLED:'NO',
  DATABASE_URL:'postgresql://runtime:password@example.neon.tech/db?sslmode=require',
  COLLECTOR_DATABASE_URL:'postgresql://collector:password@example.neon.tech/db?sslmode=require',
  QUALITY_DATABASE_URL:'postgresql://quality:password@example.neon.tech/db?sslmode=require',
  RSS_SOURCES_JSON:JSON.stringify([{id:'bbc',name:'BBC',url:'https://feeds.bbci.co.uk/news/technology/rss.xml',category:'technology',enabled:true}]),
  PRODUCTION_SCHEDULE_ENABLED:'NO'};

const scheduledEnv={...productionEnv,PRODUCTION_SCHEDULE_ENABLED:'YES',OPENAI_API_KEY:'fixture-only',
  OPENAI_MODEL:'gpt-5.6-luna',OPENAI_RANKING_MONTHLY_BUDGET_NANODOLLARS:'100000000',
  OPENAI_DIGEST_MONTHLY_BUDGET_NANODOLLARS:'100000000'};
function fakeDatabases(events:string[]) {
  const database=(role:string):Database=>({
    async exec(){throw Error('unexpected exec');},
    async query<T>(){events.push(role);return {rows:[{id:userId}] as T[]};},
    async transaction(work){return work(database(role));},
  });
  return ()=>({runtime:database('runtime'),collector:database('collector'),quality:database('quality'),
    async close(){events.push('close');}});
}
test('production schedule NO drains interactive inbox without opening scheduled databases',async()=>{
  const events:string[]=[];
  await productionTick(productionEnv,new Date(),{processInbox:async()=>{events.push('inbox');},
    databases:()=>{throw Error('schedule must not execute');},runPipeline:async()=>{throw Error('unexpected pipeline');},log:()=>{}});
  assert.deepEqual(events,['inbox']);
});
test('production schedule YES drains inbox then permits pipeline and logs only status',async()=>{
  const events:string[]=[],logs:string[]=[];
  await productionTick(scheduledEnv,new Date(),{processInbox:async()=>{events.push('inbox');},databases:fakeDatabases(events),
    runPipeline:async(_deps,id,telegramId)=>{assert.equal(id,userId);assert.equal(telegramId,'12345');events.push('pipeline');return {status:'not_due'};},
    log:code=>logs.push(code)});
  assert.deepEqual(events,['inbox','pipeline','close']);assert.deepEqual(logs,['PRODUCTION_SCHEDULE_RESULT: not_due']);
});
for(const field of ['OPENAI_RANKING_MONTHLY_BUDGET_NANODOLLARS','OPENAI_DIGEST_MONTHLY_BUDGET_NANODOLLARS']) {
  test(`enabled schedule readiness and tick refuse missing ${field}`,async()=>{
    const env={...scheduledEnv,[field]:undefined},events:string[]=[];
    await assert.rejects(()=>productionReady(env,fakeDatabases(events)),new RegExp(field));
    await assert.rejects(()=>productionTick(env,new Date(),{processInbox:async()=>{events.push('inbox');},
      databases:fakeDatabases(events),runPipeline:async()=>{throw Error('unexpected pipeline');},log:()=>{}}),new RegExp(field));
    assert.deepEqual(events,['inbox']);
  });
}
test('readiness validates all three database roles; disabled schedule needs no AI budgets',async()=>{
  for(const env of [productionEnv,scheduledEnv]) {
    const events:string[]=[];await productionReady(env,fakeDatabases(events));
    assert.deepEqual(events,['runtime','runtime','runtime','runtime','collector','quality','close']);
  }
});
test('readiness refuses an enabled Brave query without explicit key and accounting config',async()=>{
  await assert.rejects(()=>productionReady({...scheduledEnv,SCHEDULE_BRAVE_QUERY:'AI news'},fakeDatabases([])),/BRAVE_API_KEY/);
});
test('news readiness and offline preflight require each Brave field even when scheduled Brave query is empty',async()=>{
  const env={...scheduledEnv,TELEGRAM_AI_ENABLED:'YES',OPENAI_TELEGRAM_MONTHLY_BUDGET_NANODOLLARS:'100000000',
    MAX_INPUT_TOKENS:'12000',MAX_OUTPUT_TOKENS:'2000',BRAVE_API_KEY:'private-fixture',BRAVE_COST_PER_REQUEST_NANODOLLARS:'1000',
    BRAVE_PRICING_VERSION:'fixture',RETRIEVAL_MONTHLY_BUDGET_NANODOLLARS:'100000'};
  assert.ok(productionPreflight(env).every(r=>r.fields.length===0));
  for(const field of ['BRAVE_API_KEY','BRAVE_COST_PER_REQUEST_NANODOLLARS','BRAVE_PRICING_VERSION','RETRIEVAL_MONTHLY_BUDGET_NANODOLLARS']) {
    const missing={...env,[field]:undefined};
    assert.deepEqual(productionPreflight(missing).find(r=>r.name==='SEARCH_BUDGET')?.fields,[field]);
    await assert.rejects(()=>productionReady(missing,fakeDatabases([])),/BRAVE_CONFIGURATION_INVALID/);
    assert.doesNotMatch(JSON.stringify(productionPreflight(missing)),/private-fixture|password/);
  }
});
test('production live check gate precedes every probe, and failures print only sanitized codes',async()=>{
  let calls=0;const logs:string[]=[];
  const checks=[{name:'BRAVE_NEWS_SEARCH',run:async()=>{calls++;throw new ModelError('BRAVE_HTTP_401');}},
    {name:'NEON_RUNTIME',run:async()=>{calls++;throw Error('postgresql://private secret message');}},
    {name:'OPENAI_LUNA',run:async()=>{calls++;}}];
  await assert.rejects(()=>runLiveChecks(undefined,checks,line=>logs.push(line)),/RUN_LIVE_PRODUCTION_CHECK_REQUIRED/);
  assert.equal(calls,0);assert.equal(logs.length,0);
  assert.equal(await runLiveChecks('YES',checks,line=>logs.push(line)),false);
  assert.deepEqual(logs,['BRAVE_NEWS_SEARCH FAIL BRAVE_HTTP_401','NEON_RUNTIME FAIL INTEGRATION_OR_DATABASE_ERROR','OPENAI_LUNA PASS']);
});

test('normal scheduled handler retains recovery/scheduling tick',async()=>{
  let ticks=0;
  const worker=createWorker({tick:async()=>{ticks++;},ready:async()=>{},processInbox:async()=>{},enqueue:async()=>true});
  await worker.scheduled({scheduledTime:123},productionEnv);
  assert.equal(ticks,1);
});

test('webhook persists before waitUntil processing and duplicate receipt schedules no second reply',async()=>{
  let inserted=true,enqueueCalls=0,processCalls=0;const pending:Promise<unknown>[]=[];
  let releaseProcess:()=>void=()=>{};const blocked=new Promise<void>(resolve=>{releaseProcess=resolve;});
  const worker=createWorker({ready:async()=>{},tick:async()=>{},
    enqueue:async()=>{enqueueCalls++;return inserted;},processInbox:async(_env,ids)=>{processCalls++;assert.deepEqual(ids,[userId]);await blocked;}});
  const makeRequest=()=>new Request('https://worker.test/telegram/webhook',{method:'POST',headers:{
    'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':'w'.repeat(32)},body:JSON.stringify({update_id:77,message:{
      message_id:8,date:1,from:{id:12345,is_bot:false},chat:{id:12345,type:'private'},text:'/start'}})});
  const ctx={waitUntil(promise:Promise<unknown>){pending.push(promise);}};
  assert.equal((await worker.fetch(makeRequest(),productionEnv,ctx)).status,200);
  assert.equal(enqueueCalls,1);assert.equal(processCalls,1);assert.equal(pending.length,1);
  inserted=false;
  assert.equal((await worker.fetch(makeRequest(),productionEnv,ctx)).status,200);
  assert.equal(enqueueCalls,2);assert.equal(processCalls,1);assert.equal(pending.length,1);
  releaseProcess();await Promise.all(pending);
});
test('news webhook persists heavy work for cron rather than HTTP waitUntil',async()=>{
  let persisted=0,processed=0;
  const worker=createWorker({ready:async()=>{},tick:async()=>{},enqueue:async()=>{persisted++;return true;},processInbox:async()=>{processed++;}},async()=>{});
  const pending:Promise<unknown>[]=[];
  for(const text of ['/news',"What's happening with NVIDIA today?"]) {
    const request=new Request('https://worker.test/telegram/webhook',{method:'POST',headers:{
      'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':'w'.repeat(32)},body:JSON.stringify({update_id:90+persisted,
        message:{message_id:90,date:1,from:{id:12345,is_bot:false},chat:{id:12345,type:'private'},text}})});
    assert.equal((await worker.fetch(request,productionEnv,{waitUntil:p=>pending.push(p)})).status,200);
  }
  assert.equal(persisted,2);assert.equal(processed,0);assert.equal(pending.length,2);await Promise.all(pending);
});

test('Worker database transaction destroys its connection before subsequent outbound work',async()=>{
  const events:string[]=[];
  const client={async query(sql:string){events.push(sql);return {rows:[]};},release(destroy?:boolean){events.push(`release:${destroy}`);}};
  const pool:TransactionPool={async connect(){events.push('connect');return client;},async end(){}};
  const db=pooledDatabase(pool,undefined,true);
  await db.transaction(async tx=>{await tx.query('SELECT 1');events.push('work-complete');});
  events.push('outbound-fetch');
  assert.deepEqual(events,['connect','BEGIN',"SELECT set_config('statement_timeout','30000',true),set_config('idle_in_transaction_session_timeout','30000',true)",'SELECT 1','work-complete','COMMIT','release:true','outbound-fetch']);
});
