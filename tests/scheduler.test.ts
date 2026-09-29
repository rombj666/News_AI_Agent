import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schedulerFixture,SCHEDULE_NOW as now } from './fixtures/scheduler.js';
import { occurrence } from '../src/scheduling/time.js';
import { initialPreferences } from '../src/domain/preferences.js';
import { runScheduledPipeline } from '../src/scheduling/pipeline.js';
import { sharedCollection } from '../src/scheduling/collection.js';
import { asUser } from '../src/db/database.js';
import { ModelError } from '../src/ai/openai.js';
import { TelegramError } from '../src/adapters/telegram/types.js';
import { createUser } from '../src/services/identity.js';
import { latestDigest } from '../src/services/news-assistant.js';
import { readPreferences,proposePreferences,decideProposal } from '../src/services/preferences.js';
import { schedulingConfig } from '../src/scheduling/config.js';
import { runModelJob } from '../src/ai/metered.js';
import { localDatabase } from '../scripts/local-db.js';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { resolve,dirname,join } from 'node:path';
const prefs={...initialPreferences(),deliveryEnabled:true};
test('07:00 local user is due, earlier user is not, disabled user is skipped',()=>{
  assert.equal(occurrence(now,prefs)?.scheduledFor.toISOString(),'2026-09-26T23:00:00.000Z');
  assert.equal(occurrence(new Date(+now-60000),prefs),null);
  assert.equal(occurrence(now,{...prefs,deliveryEnabled:false}),null);
});
test('disabled and not-yet-due pipelines do no retrieval, AI, delivery or daily claim',async()=>{
  const f=await schedulerFixture();try {
    assert.equal((await runScheduledPipeline(f.deps,f.userId,f.telegramId,new Date(+now-60000))).status,'not_due');
    const p=await readPreferences(f.db.runtime,f.userId);
    const proposal=await proposePreferences(f.db.runtime,f.userId,{...p.document,deliveryEnabled:false},{now:()=>now},p.version);
    await decideProposal(f.db.runtime,f.userId,proposal.id,'confirm',{now:()=>now});
    assert.equal((await runScheduledPipeline(f.deps,f.userId,f.telegramId,now)).status,'not_due');
    assert.deepEqual(f.counts,{retrieval:0,ranking:0,digest:0});assert.equal(f.transport.sent.length,0);
    assert.equal((await asUser(f.db.runtime,f.userId,tx=>tx.query('SELECT id FROM scheduled_pipeline_runs'))).rows.length,0);
  }finally{await f.db.close();}
});
test('different timezone, spring gap and fall repeated hour preserve one local occurrence',()=>{
  assert.equal(occurrence(new Date('2026-09-26T10:00:00Z'),{...prefs,timezone:'America/New_York'}),null);
  const gap=occurrence(new Date('2026-03-08T07:00:00Z'),{...prefs,timezone:'America/New_York',deliveryTime:'02:30'});
  assert.equal(gap?.scheduledFor.toISOString(),'2026-03-08T07:00:00.000Z');
  const repeated=occurrence(new Date('2026-11-01T06:30:00Z'),{...prefs,timezone:'America/New_York',deliveryTime:'01:30'});
  assert.equal(repeated?.scheduledFor.toISOString(),'2026-11-01T05:30:00.000Z');
});
test('late same-day execution keeps original scheduled_for; manual ignores enablement without changing it',()=>{
  assert.equal(occurrence(new Date(+now+3600000),prefs)?.scheduledFor.toISOString(),now.toISOString());
  assert.equal(occurrence(now,initialPreferences(),true)?.scheduledFor.toISOString(),now.toISOString());
});
test('live configuration requires explicit opt-in and separate ranking/digest budgets',()=>{
  assert.throws(()=>schedulingConfig({}),/RUN_LIVE_SCHEDULED_PIPELINE/);
  const config=schedulingConfig({RUN_LIVE_SCHEDULED_PIPELINE:'YES',OPENAI_API_KEY:'secret',OPENAI_RANKING_MONTHLY_BUDGET_NANODOLLARS:'100000000',OPENAI_DIGEST_MONTHLY_BUDGET_NANODOLLARS:'200000000'});
  assert.equal(config.rankingLimits.budgetScope,'job_type');assert.equal(config.notifyEmpty,false);
});
test('complete pipeline persists stages, usage and Telegram delivery; /news returns that digest; restart is free',async()=>{
  const f=await schedulerFixture();try {
    const first=await runScheduledPipeline(f.deps,f.userId,f.telegramId,now);
    assert.equal(first.status,'completed');assert.deepEqual(f.counts,{retrieval:1,ranking:1,digest:1});assert.ok(f.transport.sent.length>1);
    assert.equal((await latestDigest(f.db.runtime,f.userId))?.id,first.digestId);
    assert.equal((await runScheduledPipeline({...f.deps},f.userId,f.telegramId,new Date(+now+3600000))).status,'already_attempted');
    assert.deepEqual(f.counts,{retrieval:1,ranking:1,digest:1});
    const runs=await asUser(f.db.runtime,f.userId,tx=>tx.query('SELECT * FROM scheduled_pipeline_runs'));
    assert.equal(runs.rows[0]!.delivery_status,'sent');assert.equal(runs.rows[0]!.candidate_count,2);
    const usage=await asUser(f.db.runtime,f.userId,tx=>tx.query('SELECT * FROM ai_usage'));
    assert.equal(usage.rows.length,2);assert.ok(usage.rows.every(r=>r.estimated_cost_nanodollars!==null));
  } finally {await f.db.close();}
});
test('concurrent duplicate event claims only one daily run',async()=>{
  const f=await schedulerFixture();try {
    const results=await Promise.all([runScheduledPipeline(f.deps,f.userId,f.telegramId,now),runScheduledPipeline(f.deps,f.userId,f.telegramId,now)]);
    assert.deepEqual(results.map(r=>r.status).sort(),['already_attempted','completed']);assert.equal(f.counts.ranking,1);
  } finally {await f.db.close();}
});
test('no fresh candidates skips both AI stages and delivery; optional notice is safe',async()=>{
  const f=await schedulerFixture(true);try {
    f.deps.notifyEmpty=true;
    const result=await runScheduledPipeline(f.deps,f.userId,f.telegramId,now);
    assert.equal(result.status,'no_fresh');assert.equal(f.counts.ranking+f.counts.digest,0);
    assert.equal(f.transport.sent[0]?.message.plain,'No fresh briefing was generated this morning.');
  } finally {await f.db.close();}
});
test('retrieval failure continues with cached fresh articles and records the failure',async()=>{
  const f=await schedulerFixture();try {
    await sharedCollection(f.db.collector,f.deps.sources,new Date(+now-3600000),undefined,{now:()=>now});
    f.deps.sources[0]!.retriever={...f.deps.sources[0]!.retriever,collect:async()=>{throw new Error('secret provider');}};
    const result=await runScheduledPipeline(f.deps,f.userId,f.telegramId,now);
    assert.equal(result.status,'completed');
    const rows=await asUser(f.db.runtime,f.userId,tx=>tx.query<{retrieval_result:{status:string}[]}>('SELECT retrieval_result FROM scheduled_pipeline_runs'));
    assert.equal(rows.rows[0]!.retrieval_result[0]!.status,'failed');
  } finally {await f.db.close();}
});
for(const stage of ['ranking','digest'] as const) test(`${stage} failure records stage and prevents automatic billable retry`,async()=>{
  const f=await schedulerFixture();try {
    const original=f.deps.model;
    f.deps.model={...original,generate:async request=>{
      const isDigest=!!JSON.parse(request.context).stories[0].sources;
      if(isDigest===(stage==='digest')) throw new ModelError('MODEL_TIMEOUT');
      return original.generate(request);
    }};
    const result=await runScheduledPipeline(f.deps,f.userId,f.telegramId,now);
    assert.equal(result.status,'failed');assert.equal(result.failureStage,stage);assert.equal(f.transport.sent.length,0);
    const run=await asUser(f.db.runtime,f.userId,tx=>tx.query('SELECT failure_stage,failure_code FROM scheduled_pipeline_runs WHERE id=$1',[result.runId]));
    assert.equal(run.rows[0]!.failure_stage,stage);assert.equal(run.rows[0]!.failure_code,'MODEL_TIMEOUT');
    assert.equal((await runScheduledPipeline(f.deps,f.userId,f.telegramId,now)).status,'already_attempted');
    const usage=await asUser(f.db.runtime,f.userId,tx=>tx.query('SELECT status FROM ai_usage'));
    assert.ok(usage.rows.some(r=>r.status==='unknown'));
  } finally {await f.db.close();}
});
test('Telegram uncertainty preserves digest and never resends on restart',async()=>{
  const f=await schedulerFixture();try {
    f.transport.failure=new TelegramError('TELEGRAM_NETWORK_OR_RESPONSE_ERROR');
    const result=await runScheduledPipeline(f.deps,f.userId,f.telegramId,now);
    assert.equal(result.status,'uncertain');assert.ok(await latestDigest(f.db.runtime,f.userId));
    f.transport.failure=null;
    assert.equal((await runScheduledPipeline(f.deps,f.userId,f.telegramId,now)).status,'already_attempted');assert.equal(f.transport.sent.length,0);
  } finally {await f.db.close();}
});
test('existing digest is delivered without ranking or generation',async()=>{
  const f=await schedulerFixture();try {
    const first=await runScheduledPipeline(f.deps,f.userId,f.telegramId,now);
    // Model a digest generated by a separate manual path: remove only test delivery/run metadata.
    await f.db.owner.query('DELETE FROM telegram_deliveries');await f.db.owner.query('DELETE FROM scheduled_pipeline_runs');
    f.transport.sent=[];
    const second=await runScheduledPipeline(f.deps,f.userId,f.telegramId,now);
    assert.equal(second.digestId,first.digestId);assert.equal(f.counts.ranking,1);assert.equal(f.counts.digest,1);
  } finally {await f.db.close();}
});
test('ranking budget rejection happens before provider and daily claim prevents retries',async()=>{
  const f=await schedulerFixture();try {
    f.deps.rankingLimits={...f.deps.rankingLimits,monthlyBudgetNanodollars:1n};
    const result=await runScheduledPipeline(f.deps,f.userId,f.telegramId,now);
    assert.equal(result.failureCode,'RANKING_BUDGET_EXCEEDED');assert.equal(f.counts.ranking,0);assert.equal(f.counts.digest,0);
  } finally {await f.db.close();}
});
test('shared retrieval is reused for two users, with private runs protected by RLS',async()=>{
  const f=await schedulerFixture();try {
    await runScheduledPipeline(f.deps,f.userId,f.telegramId,now);
    const second=await createUser(f.db.owner,'223344');
    const result=await runScheduledPipeline(f.deps,second,'223344',now,true);
    assert.equal(result.status,'completed');assert.equal(f.counts.retrieval,1);assert.equal(f.counts.ranking,2);
    assert.equal((await f.db.runtime.query('SELECT * FROM scheduled_pipeline_runs')).rows.length,0);
    assert.equal((await asUser(f.db.runtime,second,tx=>tx.query('SELECT * FROM scheduled_pipeline_runs'))).rows.length,1);
  } finally {await f.db.close();}
});
test('delivery settings use existing confirmation, expiry and optimistic version checks',async()=>{
  const f=await schedulerFixture();try {
    const p=await readPreferences(f.db.runtime,f.userId);
    const proposal=await proposePreferences(f.db.runtime,f.userId,{...p.document,deliveryTime:'08:30'},{now:()=>now},p.version);
    assert.equal((await readPreferences(f.db.runtime,f.userId)).document.deliveryTime,'07:00');
    await decideProposal(f.db.runtime,f.userId,proposal.id,'confirm',{now:()=>now});
    const settings=await asUser(f.db.runtime,f.userId,tx=>tx.query('SELECT * FROM delivery_settings'));
    assert.equal(settings.rows[0]!.local_time,'08:30');
    await assert.rejects(()=>decideProposal(f.db.runtime,f.userId,proposal.id,'confirm',{now:()=>now}));
  } finally {await f.db.close();}
});
test('conversation budget is separate from scheduled ranking and digest ledgers',async()=>{
  const f=await schedulerFixture();try {
    await runScheduledPipeline(f.deps,f.userId,f.telegramId,now);
    const request={userId:f.userId,operationId:crypto.randomUUID(),jobType:'news_explanation' as const,key:'test',context:'{}',instructions:'test',schema:{},now,
      limits:{monthlyBudgetNanodollars:4201000n,maxInputTokens:12000,maxOutputTokens:1000,budgetScope:'conversation' as const},parse:(v:unknown)=>v};
    const model={...f.deps.model,generate:async()=>({text:'{}',usage:{inputTokens:1,cachedInputTokens:0,outputTokens:1},requestId:null})};
    await runModelJob(f.db.runtime,model,request);
    await assert.rejects(()=>runModelJob(f.db.runtime,model,{...request,operationId:crypto.randomUUID(),limits:{...request.limits,budgetScope:'all'}}),/BUDGET/);
  } finally {await f.db.close();}
});

test('persistent restart and another local process cannot rerun or simultaneously open the database',async()=>{
  const parent=resolve('.local');await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(join(parent,'scheduler-test-'));
  const path=join(directory,'db');
  const f=await schedulerFixture(false,path);
  let closed=false;
  try {
    await assert.rejects(()=>localDatabase(path),/EEXIST/);
    assert.equal((await runScheduledPipeline(f.deps,f.userId,f.telegramId,now)).status,'completed');
    await f.db.close();closed=true;
    const reopened=await localDatabase(path);
    try {
      const deps={...f.deps,db:reopened.runtime,collector:reopened.collector,quality:reopened.quality};
      assert.equal((await runScheduledPipeline(deps,f.userId,f.telegramId,now)).status,'already_attempted');
      assert.equal(f.counts.ranking,1);assert.equal(f.counts.retrieval,1);
    } finally {await reopened.close();}
  } finally {
    if(!closed) await f.db.close();
    if(dirname(resolve(directory))!==parent) throw new Error('UNSAFE_TEST_CLEANUP');
    await rm(directory,{recursive:true,force:true});
  }
});
test('digest budget rejection preserves successful ranking and never calls digest provider',async()=>{
  const f=await schedulerFixture();try {
    f.deps.digestLimits={...f.deps.digestLimits,monthlyBudgetNanodollars:1n};
    const result=await runScheduledPipeline(f.deps,f.userId,f.telegramId,now);
    assert.equal(result.failureCode,'DIGEST_BUDGET_EXCEEDED');assert.equal(f.counts.ranking,1);assert.equal(f.counts.digest,0);
  } finally {await f.db.close();}
});
test('Brave allowance rejection never calls provider and cached RSS still supports the briefing',async()=>{
  const f=await schedulerFixture();try {
    let calls=0;
    f.deps.sources.push({retriever:{provider:'brave',collect:async()=>{calls++;throw new Error('should not call');}},
      request:{query:'public news',category:'world',limit:3},limits:{braveCostPerRequest:2n,monthlyBudget:1n,dailyRequests:1,pricingVersion:'test'}});
    const result=await runScheduledPipeline(f.deps,f.userId,f.telegramId,now);
    assert.equal(result.status,'completed');assert.equal(calls,0);
  } finally {await f.db.close();}
});
test('partial Telegram delivery is persisted; duplicate event never resends the successful prefix',async()=>{
  const f=await schedulerFixture();try {
    const send=f.transport.sendMessage.bind(f.transport);
    f.transport.sendMessage=async(chat,message)=>{
      if(f.transport.sent.length===1)throw new TelegramError('TELEGRAM_NETWORK_OR_RESPONSE_ERROR');
      return send(chat,message);
    };
    assert.equal((await runScheduledPipeline(f.deps,f.userId,f.telegramId,now)).status,'uncertain');
    assert.equal(f.transport.sent.length,1);
    assert.equal((await runScheduledPipeline(f.deps,f.userId,f.telegramId,now)).status,'already_attempted');
    const rows=await asUser(f.db.runtime,f.userId,tx=>tx.query<{status:string}>('SELECT status FROM telegram_deliveries ORDER BY part'));
    assert.deepEqual(rows.rows.map(r=>r.status),['sent','uncertain']);
  } finally {await f.db.close();}
});
test('interrupted run remains claimed after restart and cannot rebill',async()=>{
  const f=await schedulerFixture();try {
    await asUser(f.db.runtime,f.userId,tx=>tx.query(`INSERT INTO scheduled_pipeline_runs(user_id,local_date,digest_type,scheduled_for,started_at)
      VALUES($1,'2026-09-27','normal',$2,$2)`,[f.userId,now.toISOString()]));
    assert.equal((await runScheduledPipeline(f.deps,f.userId,f.telegramId,now)).status,'already_attempted');
    assert.deepEqual(f.counts,{retrieval:0,ranking:0,digest:0});
  } finally {await f.db.close();}
});
