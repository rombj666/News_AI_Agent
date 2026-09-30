import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schedulerFixture,SCHEDULE_NOW as now } from './fixtures/scheduler.js';
import { createNewsNow,newsSearchPlan,NewsNowError } from '../src/services/news-now.js';
import { classifyMessage,respondToNews } from '../src/services/news-assistant.js';
import { BraveRetriever } from '../src/retrieval/brave.js';
import { asUser } from '../src/db/database.js';
import { readPreferences,proposePreferences,decideProposal } from '../src/services/preferences.js';
import { initialPreferences } from '../src/domain/preferences.js';
import { createTelegramRouter } from '../src/adapters/telegram/router.js';
import { messageUpdate,callbackUpdate } from './fixtures/telegram.js';
import { parseDeliveryTime } from '../src/services/schedule.js';
import { occurrence } from '../src/scheduling/time.js';
import { runScheduledPipeline } from '../src/scheduling/pipeline.js';
import { ModelError } from '../src/ai/openai.js';
import { createUser } from '../src/services/identity.js';
import { enqueueUpdate,drainInbox,isNewsUpdate } from '../src/production/inbox.js';

for(const [text,intent] of [
  ['/news','NEWS_NOW'],['Give me the latest news','NEWS_NOW'],['AI news today','NEWS_NOW'],
  ['Give me AI news today','NEWS_NOW'],['latest Malaysia AI news','NEWS_NOW'],['Show me technology news now','NEWS_NOW'],
  ["What's happening with NVIDIA?",'CURRENT_NEWS_QUESTION'],["What's happening with NVIDIA today?",'CURRENT_NEWS_QUESTION'],
  ['What happened with Microsoft this week?','CURRENT_NEWS_QUESTION'],['Any important AI news in Malaysia?','CURRENT_NEWS_QUESTION'],
  ['Latest OpenAI news','NEWS_NOW'],['more AI news every day','PERMANENT_PREFERENCE'],
  ['Give me more AI news every day','PERMANENT_PREFERENCE'],['Stop entertainment news','PERMANENT_PREFERENCE'],
  ['Stop showing entertainment news','PERMANENT_PREFERENCE'],['Send my news at 8:30 AM','SCHEDULE_CHANGE'],
  ['Change my briefing to 12:30 PM','SCHEDULE_CHANGE'],['Focus on NVIDIA this week','TEMPORARY_INTEREST'],
  ['Explain story 2','STORY_QUESTION'],['/latest','COMMAND'],['/preferences','COMMAND'],
] as const)test(`intent: ${text}`,()=>assert.equal(classifyMessage(text),intent));

for(const [input,expected] of [['8 AM','08:00'],['8:30 AM','08:30'],['12 AM','00:00'],['12 PM','12:00'],
  ['12:30 PM','12:30'],['7 PM','19:00'],['19:00','19:00'],['24:00',null],['13 PM',null],['8',null]] as const)
  test(`schedule time: ${input}`,()=>assert.equal(parseDeliveryTime(input),expected));

test('personalized plan uses priorities/regions; explicit scope overrides them without mutation',()=>{
  const p={...initialPreferences(),topics:{AI:5,football:0},regions:{Malaysia:4,USA:4},exclusions:['entertainment news']};
  const before=structuredClone(p),personal=newsSearchPlan('/news',p),explicit=newsSearchPlan('Latest NVIDIA news',p);
  assert.match(personal.query,/ai/);assert.match(personal.query,/malaysia/);assert.match(personal.query,/usa/);assert.doesNotMatch(personal.query,/football/);
  assert.equal(explicit.query,'nvidia');assert.equal(newsSearchPlan('What happened with OpenAI this week?',p).windowHours,168);
  assert.deepEqual(p,before);
});

async function fixture(mode:'success'|'empty'|'malformed'|'http'='success') {
  const f=await schedulerFixture();let searches=0;const queries:string[]=[];
  const brave=new BraveRetriever('fixture-key',async url=>{
    searches++;queries.push(new URL(url).searchParams.get('q')!);
    if(mode==='http')return new Response('private provider response',{status:401});
    if(mode==='malformed')return new Response('not json private');
    return Response.json({results:mode==='empty'?[]:f.items.map(item=>({title:item.title,url:item.url,
      description:item.excerpt,page_age:item.publishedAt,profile:{name:item.source}}))});
  },{now:()=>now});
  const deps={...f.deps,brave,braveLimits:{braveCostPerRequest:1000n,monthlyBudget:10000n,pricingVersion:'fixture',dailyRequests:10},rss:f.deps.sources};
  const request={userId:f.userId,operationId:crypto.randomUUID(),text:'/news',question:false,now};
  return {...f,deps,request,queries,get searches(){return searches;}};
}
test('/news retrieves Brave + RSS, deduplicates, saves digest, meters usage and is replay-safe',async()=>{
  const f=await fixture();try {
    const before=await readPreferences(f.db.runtime,f.userId),run=createNewsNow(f.deps);
    const digest=await run(f.request);assert.ok(digest);assert.equal(digest.outputStoryCount,2);
    assert.equal(f.searches,1);assert.equal(f.counts.retrieval,1);assert.equal(f.counts.ranking,1);assert.equal(f.counts.digest,1);
    assert.equal((await f.db.owner.query('SELECT id FROM articles')).rows.length,2);
    assert.equal((await run(f.request))?.id,digest.id);assert.equal(f.searches,1);assert.equal(f.counts.ranking,1);
    assert.deepEqual(await readPreferences(f.db.runtime,f.userId),before);
    const usage=await asUser(f.db.runtime,f.userId,tx=>tx.query('SELECT provider,job_type FROM ai_usage'));
    assert.equal(usage.rows.length,3);
    const other=await createUser(f.db.owner,'987654');
    assert.equal((await asUser(f.db.runtime,other,tx=>tx.query('SELECT id FROM news_now_runs'))).rows.length,0);
    assert.equal((await asUser(f.db.runtime,other,tx=>tx.query('SELECT query FROM retrieval_runs'))).rows.length,0);
    await assert.rejects(()=>run({...f.request,text:'Latest other news'}),/NEWS_REQUEST_CONFLICT/);
  }finally{await f.db.close();}
});
test('explicit request scopes fresh results and direct questions use a short source-linked saved digest',async()=>{
  const f=await fixture();try {
    const digest=await createNewsNow(f.deps)({...f.request,text:"What's happening with telescope software today?",question:true});
    assert.ok(digest);assert.equal(digest.type,'quick');assert.equal(digest.outputStoryCount,1);
    assert.match(digest.sections[0]!.items[0]!.headline,/telescope/);assert.ok(digest.sections[0]!.items[0]!.sources.length);
    assert.equal(f.queries[0],'telescope software');
  }finally{await f.db.close();}
});
test('one-time scoped briefing cannot replace the automatic daily briefing',async()=>{
  const f=await fixture();try {
    const personal=await createNewsNow(f.deps)({...f.request,text:'Latest telescope news'});assert.equal(personal?.outputStoryCount,1);
    const scheduled=await runScheduledPipeline(f.deps,f.userId,f.telegramId,now);
    assert.equal(scheduled.status,'completed');assert.notEqual(scheduled.digestId,personal?.id);
    assert.equal(f.counts.ranking,2);assert.equal(f.counts.digest,2);
    const rows=await asUser(f.db.runtime,f.userId,tx=>tx.query('SELECT purpose FROM digests ORDER BY revision'));
    assert.deepEqual(rows.rows.map(r=>r.purpose),['news_now','scheduled']);
  }finally{await f.db.close();}
});
test('Brave-only page-age results work in live flow; stale and irrelevant results never reach Luna',async()=>{
  const f=await fixture();try {
    f.deps.rss=[];
    f.items[1]!.publishedAt=new Date(+now-2*86400000).toISOString();
    const digest=await createNewsNow(f.deps)(f.request);assert.equal(digest?.outputStoryCount,1);
    f.items[0]!.publishedAt=null;
    const empty=await createNewsNow(f.deps)({...f.request,operationId:crypto.randomUUID(),text:'Latest nonexistent topic news'});
    assert.equal(empty,null);assert.equal(f.counts.ranking,1);
  }finally{await f.db.close();}
});
test('undated Brave-only results do not produce current-news claims',async()=>{
  const f=await fixture();try {
    f.deps.rss=[];for(const item of f.items)item.publishedAt=null;
    assert.equal(await createNewsNow(f.deps)(f.request),null);assert.equal(f.counts.ranking+f.counts.digest,0);
  }finally{await f.db.close();}
});
test('failed Brave and Luna give distinct safe Telegram replies; no-results is not a configuration error',async()=>{
  const f=await fixture('http');try {
    const logs:string[]=[];
    const handle=createTelegramRouter({db:f.db.runtime,botId:'123456',identities:new Map([[f.telegramId,f.userId]]),transport:f.transport,
      ai:null,newsNow:createNewsNow(f.deps),now:()=>now,log:line=>logs.push(line)});
    assert.equal(await handle(messageUpdate(500,Number(f.telegramId),'/news')),'failed');
    assert.equal(f.transport.sent.at(-1)!.message.plain,'Live news search is temporarily unavailable.');
    assert.deepEqual(logs,['TELEGRAM_APPLICATION_REQUEST_FAILED: BRAVE_HTTP_401']);
    const missing=createTelegramRouter({db:f.db.runtime,botId:'123456',identities:new Map([[f.telegramId,f.userId]]),transport:f.transport,ai:null,now:()=>now});
    await missing(messageUpdate(501,Number(f.telegramId),'/news'));
    assert.equal(f.transport.sent.at(-1)!.message.plain,'Live news search is temporarily unavailable.');
    const generation=createTelegramRouter({db:f.db.runtime,botId:'123456',identities:new Map([[f.telegramId,f.userId]]),transport:f.transport,
      ai:null,newsNow:async()=>{throw new NewsNowError('MODEL_TIMEOUT','generation');},now:()=>now});
    await generation(messageUpdate(502,Number(f.telegramId),'/news'));
    assert.equal(f.transport.sent.at(-1)!.message.plain,"I found news, but couldn't prepare the briefing right now.");
  }finally{await f.db.close();}
});
for(const mode of ['empty','malformed','http'] as const)test(`Brave ${mode} has distinct outcome and no AI calls`,async()=>{
  const f=await fixture(mode);try {
    const run=createNewsNow(f.deps);
    if(mode==='empty')assert.equal(await run(f.request),null);
    else await assert.rejects(()=>run(f.request),mode==='http'?/BRAVE_HTTP_401/:/BRAVE_INVALID_BRAVE_RESPONSE/);
    assert.equal(f.counts.ranking+f.counts.digest,0);
    if(mode!=='empty')await assert.rejects(()=>run(f.request),/NEWS_ALREADY_ATTEMPTED/);
    assert.equal(f.searches,1);
  }finally{await f.db.close();}
});
test('Brave allowance rejects before another call and failed request remains claimed',async()=>{
  const f=await fixture();try {
    f.deps.braveLimits.dailyRequests=1;const run=createNewsNow(f.deps);await run(f.request);
    const next={...f.request,operationId:crypto.randomUUID()};
    await assert.rejects(()=>run(next),/BRAVE_BUDGET_EXCEEDED/);
    await assert.rejects(()=>run(next),/NEWS_ALREADY_ATTEMPTED/);assert.equal(f.searches,1);
  }finally{await f.db.close();}
});
test('Luna failure keeps safe stage/code and reservations with no automatic retry',async()=>{
  const f=await fixture();try {
    f.deps.model={...f.deps.model,generate:async()=>{throw new ModelError('MODEL_TIMEOUT');}};
    const run=createNewsNow(f.deps);
    await assert.rejects(()=>run(f.request),error=>error instanceof NewsNowError&&error.stage==='generation'&&error.code==='MODEL_TIMEOUT');
    await assert.rejects(()=>run(f.request),/NEWS_ALREADY_ATTEMPTED/);
    const rows=await asUser(f.db.runtime,f.userId,tx=>tx.query('SELECT status,estimated_cost_nanodollars,reserved_cost_nanodollars FROM ai_usage WHERE provider=\'openai\''));
    assert.equal(rows.rows[0]!.status,'unknown');assert.equal(rows.rows[0]!.estimated_cost_nanodollars,null);assert.ok(BigInt(String(rows.rows[0]!.reserved_cost_nanodollars))>0n);
  }finally{await f.db.close();}
});
test('duplicate /news webhook or navigation button cannot pay twice; /latest performs no retrieval',async()=>{
  const f=await fixture();try {
    const handle=createTelegramRouter({db:f.db.runtime,botId:'123456',identities:new Map([[f.telegramId,f.userId]]),transport:f.transport,
      ai:null,newsNow:createNewsNow(f.deps),now:()=>now});
    const update=messageUpdate(777,Number(f.telegramId),'/news');
    assert.equal(await handle(update),'completed');assert.equal(await handle(update),'duplicate');assert.equal(f.searches,1);
    assert.equal(await handle(messageUpdate(778,Number(f.telegramId),'/latest')),'completed');assert.equal(f.searches,1);
    const button=callbackUpdate(779,Number(f.telegramId),'nav:news','one-navigation');
    assert.equal(await handle(button),'completed');assert.equal(await handle({...button,update_id:780}),'duplicate');assert.equal(f.searches,2);
  }finally{await f.db.close();}
});
test('lightweight drain leaves heavy requests pending; concurrent cron drains generate only once',async()=>{
  const f=await fixture();try {
    const handle=createTelegramRouter({db:f.db.runtime,botId:'123456',identities:new Map([[f.telegramId,f.userId]]),transport:f.transport,
      ai:null,newsNow:createNewsNow(f.deps),now:()=>now});
    await enqueueUpdate(f.db.runtime,f.userId,'123456',messageUpdate(800,Number(f.telegramId),'/news'));
    await enqueueUpdate(f.db.runtime,f.userId,'123456',messageUpdate(801,Number(f.telegramId),'/schedule'));
    assert.equal(await drainInbox(f.db.runtime,f.userId,'123456',handle,5,Date.now()+60000,raw=>!isNewsUpdate(raw)),0);
    assert.equal(f.searches,0);
    const pending=await asUser(f.db.runtime,f.userId,tx=>tx.query('SELECT status FROM telegram_webhook_inbox'));
    assert.ok(pending.rows.every(r=>r.status==='pending'));
    await Promise.all([drainInbox(f.db.runtime,f.userId,'123456',handle),drainInbox(f.db.runtime,f.userId,'123456',handle)]);
    assert.equal(f.searches,1);assert.equal(f.counts.ranking,1);
    assert.equal(await drainInbox(f.db.runtime,f.userId,'123456',handle),0);
    const completed=await asUser(f.db.runtime,f.userId,tx=>tx.query('SELECT status,payload FROM telegram_webhook_inbox'));
    assert.ok(completed.rows.every(r=>r.status==='completed'&&r.payload===null));
  }finally{await f.db.close();}
});
test('/schedule confirmation rereads committed state; cancellation preserves it and occurrence uses new time',async()=>{
  const f=await fixture();try {
    const ask=(text:string)=>respondToNews(f.db.runtime,{userId:f.userId,operationId:crypto.randomUUID(),text},null,now);
    const current=await ask('/schedule');assert.equal(current.kind,'text');if(current.kind==='text')assert.match(current.text,/7:00 AM/);
    const proposal=await ask('/schedule 12:30 PM');if(proposal.kind!=='proposal')throw Error('proposal missing');
    assert.equal((await readPreferences(f.db.runtime,f.userId)).document.deliveryTime,'07:00');
    const confirmation=await respondToNews(f.db.runtime,{userId:f.userId,operationId:crypto.randomUUID(),action:{kind:'confirm',proposalId:proposal.proposalId}},null,now);
    assert.equal(confirmation.kind,'text');if(confirmation.kind==='text')assert.match(confirmation.text,/Schedule updated.*\n[\s\S]*12:30 PM/);
    const p=await readPreferences(f.db.runtime,f.userId);assert.equal(p.document.deliveryTime,'12:30');assert.equal(p.document.deliveryEnabled,true);
    assert.equal(occurrence(now,p.document),null);assert.ok(occurrence(new Date(+now+330*60000),p.document));
    assert.equal((await runScheduledPipeline(f.deps,f.userId,f.telegramId,now)).status,'not_due');
    assert.equal((await runScheduledPipeline(f.deps,f.userId,f.telegramId,new Date(+now+330*60000))).status,'completed');
    assert.equal((await runScheduledPipeline(f.deps,f.userId,f.telegramId,new Date(+now+331*60000))).status,'already_attempted');
    const off=await ask('/schedule off');if(off.kind!=='proposal')throw Error('proposal missing');
    await decideProposal(f.db.runtime,f.userId,off.proposalId,'cancel',{now:()=>now});
    assert.equal((await readPreferences(f.db.runtime,f.userId)).document.deliveryEnabled,true);
    const disable=await proposePreferences(f.db.runtime,f.userId,{...p.document,deliveryEnabled:false},{now:()=>now});
    await decideProposal(f.db.runtime,f.userId,disable.id,'confirm',{now:()=>now});
    const time=await ask('Send my news at 8:30 AM');if(time.kind!=='proposal')throw Error('proposal missing');
    await decideProposal(f.db.runtime,f.userId,time.proposalId,'confirm',{now:()=>now});
    assert.equal((await readPreferences(f.db.runtime,f.userId)).document.deliveryEnabled,false);
    const overview=await ask('/preferences');if(overview.kind==='text')assert.match(overview.text,/08:30/);
  }finally{await f.db.close();}
});
