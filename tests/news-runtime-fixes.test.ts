import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTelegramCommands } from '../scripts/telegram-set-commands.js';
import { acknowledgeNewsUpdate } from '../src/production/news-status.js';
import { createWorker } from '../src/entrypoints/worker.js';
import { validatedNewsNowConfig } from '../src/production/news.js';
import { safeFailure } from '../src/adapters/telegram/diagnostics.js';
import { NewsNowError } from '../src/services/news-now.js';
import type { TelegramUpdate } from '../src/adapters/telegram/types.js';

const token='123456:abcdefghijklmnopqrstuvwxyz0123456789';
const userId='11111111-1111-4111-8111-111111111111';
const env={TELEGRAM_BOT_TOKEN:token,TELEGRAM_WEBHOOK_SECRET:'w'.repeat(32),PRODUCTION_HEALTH_SECRET:'s'.repeat(32),
  TELEGRAM_ALLOWED_USER_IDS:'12345',TELEGRAM_USER_MAP:JSON.stringify({'12345':userId}),TELEGRAM_AI_ENABLED:'NO',
  DATABASE_URL:'postgresql://runtime:password@example.neon.tech/db?sslmode=require',
  COLLECTOR_DATABASE_URL:'postgresql://collector:password@example.neon.tech/db?sslmode=require',
  QUALITY_DATABASE_URL:'postgresql://quality:password@example.neon.tech/db?sslmode=require',
  RSS_SOURCES_JSON:JSON.stringify([{id:'bbc',name:'BBC',url:'https://feeds.bbci.co.uk/news/technology/rss.xml',category:'technology',enabled:true}])};
const message={message_id:8,date:1,from:{id:12345,is_bot:false},chat:{id:12345,type:'private' as const},text:'/news'};
const request=(update:TelegramUpdate)=>new Request('https://worker.test/telegram/webhook',{method:'POST',headers:{
  'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':env.TELEGRAM_WEBHOOK_SECRET},body:JSON.stringify(update)});

test('operator command calls only setMyCommands with six production commands and safe output',async()=>{
  const calls:string[]=[],logs:string[]=[];
  await setTelegramCommands({TELEGRAM_BOT_TOKEN:token},async(url,init)=>{
    calls.push(String(url).split('/').at(-1)!);
    assert.deepEqual(JSON.parse(String(init?.body)),{commands:[
      {command:'start',description:'Help and examples'},{command:'news',description:'Fresh personalized news now'},
      {command:'latest',description:'Latest saved briefing'},{command:'schedule',description:'View or change daily delivery'},
      {command:'preferences',description:'View your settings'},{command:'help',description:'Help and examples'}]});
    return Response.json({ok:true,result:true});
  },line=>logs.push(line));
  assert.deepEqual(calls,['setMyCommands']);assert.deepEqual(logs,['TELEGRAM_COMMANDS_UPDATED']);
});

for(const text of ['/news','Latest Malaysia AI news',"What's happening with NVIDIA?",'callback']) {
  test(`new heavy request acknowledges immediately, duplicate does not, cron retains work: ${text}`,async()=>{
    const update:TelegramUpdate=text==='callback'?{update_id:8,callback_query:{id:'callback-id',from:message.from,message,data:'nav:news'}}
      :{update_id:8,message:{...message,text}};
    let inserted=false,heavy=0;const calls:string[]=[],pending:Promise<unknown>[]=[];
    let release:()=>void=()=>{};const blocked=new Promise<void>(resolve=>{release=resolve;});
    const worker=createWorker({ready:async()=>{},tick:async()=>{heavy++;},processInbox:async()=>{throw Error('must stay deferred');},
      enqueue:async()=>{if(inserted)return false;inserted=true;return true;}},
      (config,raw)=>acknowledgeNewsUpdate(config,raw,async(url,init)=>{
        assert.equal(inserted,true);const method=String(url).split('/').at(-1)!;calls.push(method);
        const body=JSON.parse(String(init?.body));
        if(text==='callback'){assert.equal(method,'answerCallbackQuery');assert.equal(body.callback_query_id,'callback-id');assert.equal(body.text,'Searching for fresh news…');}
        else {assert.equal(method,'sendMessage');assert.equal(body.text,'🔎 Searching for fresh news now. This may take a moment.');}
        await blocked;return Response.json({ok:true,result:{message_id:9}});
      }));
    const ctx={waitUntil:(p:Promise<unknown>)=>{pending.push(p);}};
    assert.equal((await worker.fetch(request(update),env,ctx)).status,200);
    assert.equal((await worker.fetch(request(update),env,ctx)).status,200);
    assert.equal(calls.length,1);assert.equal(pending.length,1);assert.equal(heavy,0);
    release();await Promise.all(pending);await worker.scheduled({scheduledTime:1},env);assert.equal(heavy,1);
  });
}

const valid={OPENAI_API_KEY:'private-openai-value',OPENAI_RANKING_MONTHLY_BUDGET_NANODOLLARS:'100000',
  OPENAI_DIGEST_MONTHLY_BUDGET_NANODOLLARS:'100000',BRAVE_API_KEY:'private-brave-value',
  BRAVE_COST_PER_REQUEST_NANODOLLARS:'1000',BRAVE_PRICING_VERSION:'private-pricing-value',RETRIEVAL_MONTHLY_BUDGET_NANODOLLARS:'100000'};
test('uncertain acknowledgement does not fail intake, retry status, or start heavy work',async()=>{
  const logs:string[]=[],pending:Promise<unknown>[]=[];let inserted=false,calls=0;
  const original=console.error;console.error=(line:string)=>{logs.push(line);};
  try {
    const worker=createWorker({ready:async()=>{},tick:async()=>{},processInbox:async()=>{throw Error('heavy work');},
      enqueue:async()=>{if(inserted)return false;inserted=true;return true;}},async()=>{calls++;throw Error('private token message');});
    const ctx={waitUntil:(p:Promise<unknown>)=>{pending.push(p);}};
    assert.equal((await worker.fetch(request({update_id:2,message}),env,ctx)).status,200);
    await Promise.all(pending);
    assert.equal((await worker.fetch(request({update_id:2,message}),env,ctx)).status,200);
    assert.equal(calls,1);assert.deepEqual(logs,['TELEGRAM_NEWS_ACK_FAILED']);
  }finally{console.error=original;}
});
for(const field of ['OPENAI_API_KEY','OPENAI_RANKING_MONTHLY_BUDGET_NANODOLLARS','OPENAI_DIGEST_MONTHLY_BUDGET_NANODOLLARS',
  'MAX_INPUT_TOKENS','MAX_OUTPUT_TOKENS','BRAVE_API_KEY','BRAVE_COST_PER_REQUEST_NANODOLLARS','BRAVE_PRICING_VERSION','RETRIEVAL_MONTHLY_BUDGET_NANODOLLARS']) {
  test(`live configuration logs only invalid field name: ${field}`,()=>{
    const logs:string[]=[];
    assert.throws(()=>validatedNewsNowConfig({...valid,[field]:field.startsWith('MAX_')?'private-invalid-value':''},line=>logs.push(line)),
      (error:unknown)=>error instanceof NewsNowError&&error.code==='LIVE_NEWS_CONFIGURATION_INVALID');
    assert.deepEqual(logs,[`LIVE_NEWS_CONFIG_FIELDS: ${field}`]);assert.doesNotMatch(logs.join(),/private-|password|https:/);
  });
}
test('safe runtime codes retain retrieval, budget and model failure details without arbitrary error bodies',()=>{
  for(const code of ['BRAVE_BUDGET_EXCEEDED','BRAVE_COLLECTION_FAILED','BRAVE_HTTP_401','BRAVE_RESPONSE_INVALID',
    'PREFERENCE_BUDGET_EXCEEDED','RANKING_BUDGET_EXCEEDED','DIGEST_BUDGET_EXCEEDED','MODEL_RESPONSE_INVALID']) {
    assert.equal(safeFailure(new NewsNowError(code,'retrieval')),code);
  }
  assert.equal(safeFailure(new Error('private response token')), 'INTERNAL_OR_DATABASE_ERROR');
  assert.equal(safeFailure(new NewsNowError('private token value','retrieval')),'UNCLASSIFIED_ERROR');
});
