import assert from 'node:assert/strict';
import { test } from 'node:test';
import { telegramEgress } from '../src/production/telegram-egress.js';
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
test('minimal egress probe uses only getMe and returns sanitized response metadata',async()=>{
  let url='',init:RequestInit|undefined;
  const result=await telegramEgress(token,async(input,options)=>{url=String(input);init=options;return new Response('{"ok":true,"result":{"username":"private"}}',
    {status:200,headers:{'content-type':'application/json; charset=utf-8'}});});
  assert.equal(url,`https://api.telegram.org/bot${token}/getMe`);
  assert.deepEqual({method:init?.method,body:init?.body,headers:init?.headers},{method:'POST',body:'{}',headers:{'Content-Type':'application/json','Accept':'application/json'}});
  assert.deepEqual(result,{reached:true,status:200,contentType:'json',bytes:43,category:'SUCCESS'});
  assert.ok(!JSON.stringify(result).includes(token));assert.ok(!JSON.stringify(result).includes('private'));
});

test('minimal egress classifier covers safe Cloudflare and network categories without leaking exceptions',async()=>{
  const errors=[
    [Object.assign(new Error('private'),{cause:{code:'ENOTFOUND'}}),'DNS_FAILURE'],
    [Object.assign(new Error('private'),{cause:{code:'ECONNRESET'}}),'CONNECTION_RESET'],
    [Object.assign(new Error('private'),{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}}),'CONNECTION_TIMEOUT'],
    [new Error('Network connection lost.'),'NETWORK_CONNECTION_LOST'],
    [new TypeError('Failed to fetch private URL'),'FETCH_FAILED'],
    [new Error('Too many subrequests for private URL'),'CLOUDFLARE_SUBREQUEST_BLOCKED'],
    [new Error('private unknown detail'),'UNKNOWN_NETWORK_FAILURE'],
  ] as const;
  for(const [error,category] of errors){
    const result=await telegramEgress(token,async()=>{throw error;});
    assert.deepEqual(result,{reached:false,status:0,contentType:'none',bytes:0,category});
    assert.ok(!JSON.stringify(result).includes('private'));
  }
});

test('protected fetch diagnostic calls only egress and scheduled diagnostic bypasses production tick',async()=>{
  let egress=0,ticks=0,ready=0,enqueues=0;
  const worker=createWorker({
    egress:async()=>{egress++;return {reached:false,status:0,contentType:'none' as const,bytes:0,category:'FETCH_FAILED' as const};},
    tick:async()=>{ticks++;},ready:async()=>{ready++;},processInbox:async()=>{},enqueue:async()=>{enqueues++;return true;},
  });
  const env={PRODUCTION_HEALTH_SECRET:secret,TELEGRAM_BOT_TOKEN:token,TELEGRAM_EGRESS_DIAGNOSTIC:'YES'};
  assert.equal((await worker.fetch(new Request('https://worker.test/diagnostics/telegram-egress',{method:'POST'}),env)).status,403);
  const response=await worker.fetch(new Request('https://worker.test/diagnostics/telegram-egress',{method:'POST',headers:{Authorization:`Bearer ${secret}`}}),env);
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{reached:false,status:0,contentType:'none',bytes:0,category:'FETCH_FAILED'});
  await worker.scheduled({scheduledTime:0},env);
  assert.equal(egress,2);assert.equal(ticks,0);assert.equal(ready,0);assert.equal(enqueues,0);
});

test('scheduled diagnostics are opt-in and normal scheduled path remains intact when disabled',async()=>{
  let egress=0,ticks=0;
  const worker=createWorker({egress:async()=>{egress++;return {reached:true,status:200,contentType:'json' as const,bytes:1,category:'SUCCESS' as const};},
    tick:async()=>{ticks++;},ready:async()=>{},processInbox:async()=>{},enqueue:async()=>true});
  await worker.scheduled({scheduledTime:123},{TELEGRAM_EGRESS_DIAGNOSTIC:'NO'});
  assert.equal(egress,0);assert.equal(ticks,1);
});

test('webhook persists before waitUntil processing and duplicate receipt schedules no second reply',async()=>{
  let inserted=true,enqueueCalls=0,processCalls=0;const pending:Promise<unknown>[]=[];
  let releaseProcess:()=>void=()=>{};const blocked=new Promise<void>(resolve=>{releaseProcess=resolve;});
  const worker=createWorker({ready:async()=>{},tick:async()=>{},egress:telegramEgress,
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
