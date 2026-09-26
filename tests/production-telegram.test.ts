import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorker } from '../src/entrypoints/worker.js';
import { pooledDatabase,type TransactionPool } from '../src/db/neon.js';

const token='123456:abcdefghijklmnopqrstuvwxyz0123456789',secret='s'.repeat(32);
const userId='11111111-1111-4111-8111-111111111111';
const productionEnv={PRODUCTION_HEALTH_SECRET:secret,TELEGRAM_WEBHOOK_SECRET:'w'.repeat(32),TELEGRAM_BOT_TOKEN:token,
  TELEGRAM_ALLOWED_USER_IDS:'12345',TELEGRAM_USER_MAP:JSON.stringify({'12345':userId}),TELEGRAM_AI_ENABLED:'NO',
  DATABASE_URL:'postgresql://runtime:password@example.neon.tech/db?sslmode=require',
  COLLECTOR_DATABASE_URL:'postgresql://collector:password@example.neon.tech/db?sslmode=require',
  QUALITY_DATABASE_URL:'postgresql://quality:password@example.neon.tech/db?sslmode=require',
  RSS_SOURCES_JSON:JSON.stringify([{id:'bbc',name:'BBC',url:'https://feeds.bbci.co.uk/news/technology/rss.xml',category:'technology',enabled:true}]),
  PRODUCTION_SCHEDULE_ENABLED:'NO'};

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

test('Worker database transaction destroys its connection before subsequent outbound work',async()=>{
  const events:string[]=[];
  const client={async query(sql:string){events.push(sql);return {rows:[]};},release(destroy?:boolean){events.push(`release:${destroy}`);}};
  const pool:TransactionPool={async connect(){events.push('connect');return client;},async end(){}};
  const db=pooledDatabase(pool,undefined,true);
  await db.transaction(async tx=>{await tx.query('SELECT 1');events.push('work-complete');});
  events.push('outbound-fetch');
  assert.deepEqual(events,['connect','BEGIN',"SELECT set_config('statement_timeout','30000',true),set_config('idle_in_transaction_session_timeout','30000',true)",'SELECT 1','work-complete','COMMIT','release:true','outbound-fetch']);
});
