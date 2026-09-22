import assert from 'node:assert/strict';
import { test,before,after } from 'node:test';
import { localDatabase } from '../scripts/local-db.js';
import { createUser } from '../src/services/identity.js';
import { asUser } from '../src/db/database.js';
import { OpenAIResponses,ModelError } from '../src/ai/openai.js';
import { openaiLiveConfig } from '../src/ai/live-config.js';
import { safeLiveError } from '../src/retrieval/live-errors.js';
import { LiveConfigError,liveRetrievalConfig } from '../src/retrieval/live-config.js';
import { rankingJsonSchema,rankingOutputSchema } from '../src/ai/ranking-schema.js';
import { rankStories,type QualityInput } from '../src/ai/ranking.js';
import { LUNA_MODEL } from '../src/config/index.js';
import type { LanguageModel } from '../src/domain/ports.js';
import { normalizeArticle } from '../src/retrieval/normalize.js';
import { persistArticle } from '../src/retrieval/repository.js';
import { refreshQuality } from '../src/quality/service.js';

const now=new Date('2026-09-17T12:00:00Z');
let db:Awaited<ReturnType<typeof localDatabase>>,quality:QualityInput;
let counter=50000;
const limits={monthlyBudgetNanodollars:100_000_000n};
const classification=(clusterId:string,relevance=80)=>({clusterId,primaryCategory:'technology',secondaryCategories:[],region:null,countries:[],
  importanceScore:60,userRelevanceScore:relevance,confidence:0.8,importanceReason:'Affects access to AI tools.',entities:['OpenAI'],topics:['AI']});
const request={instructions:'test',context:'{}',maxOutputTokens:1000,responseSchema:rankingJsonSchema,signal:new AbortController().signal};
const response=(extra:Record<string,unknown>={})=>({id:'resp_fixture',model:LUNA_MODEL,status:'completed',usage:{input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:10}},
  output:[{type:'message',content:[{type:'output_text',text:'{"stories":[]}'}]}],...extra});
function fake(generate?:LanguageModel['generate']):LanguageModel {return {model:LUNA_MODEL,generate:generate??(async()=>({
  text:JSON.stringify({stories:quality.candidates.map((c,i)=>classification(c.clusterId,i?90:20))}),
  usage:{inputTokens:100,cachedInputTokens:10,outputTokens:20},requestId:'resp_fixture'}))};}
const user=()=>createUser(db.owner,String(++counter));
before(async()=>{
  db=await localDatabase();
  for(const [i,title] of ['OpenAI launches Aurora AI model','Coastal flood emergency displaces families'].entries()) {
    const a=await normalizeArticle({url:`https://example.com/${i}`,title,source:'Example',excerpt:'Verified fixture description.',
      publishedAt:'2026-09-17T08:00:00Z',fetchedAt:now.toISOString(),dateKind:'published',contentKind:'feed_excerpt',rawMetadata:{}});
    await db.collector.transaction(tx=>persistArticle(tx,a));
  }
  quality=await refreshQuality(db.quality,now);
});
after(async()=>{await db?.close();});

test('Responses adapter uses exact Luna, strict schema, no tools/history/storage and reports usage',async()=>{
  const model=new OpenAIResponses({OPENAI_API_KEY:'fixture-secret'},async(url,init)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    const body=JSON.parse(String(init.body));assert.equal(body.model,LUNA_MODEL);assert.equal(body.store,false);
    assert.deepEqual(body.tools,[]);assert.equal(body.text.format.strict,true);assert.equal(body.previous_response_id,undefined);
    assert.equal(body.max_output_tokens,1000);return Response.json(response());
  });
  const result=await model.generate(request);assert.deepEqual(result.usage,{inputTokens:100,cachedInputTokens:10,outputTokens:20});
});
test('missing key, wrong model and absent live opt-in fail safely',()=>{
  assert.throws(()=>new OpenAIResponses({}),/OPENAI_KEY_MISSING/);
  assert.throws(()=>new OpenAIResponses({OPENAI_API_KEY:'secret',OPENAI_MODEL:'other'}),/MODEL_NOT_ALLOWED/);
  assert.throws(()=>openaiLiveConfig({OPENAI_API_KEY:'do-not-print'}),e=>!String(e).includes('do-not-print')&&String(e).includes('RUN_LIVE_OPENAI'));
});
test('provider HTTP, incomplete, refusal, malformed JSON and wrong model expose safe errors',async()=>{
  const cases:[Response,string][]=[
    [new Response('credential-and-provider-body',{status:401}),'OPENAI_HTTP_401'],
    [new Response('secret invalid json'),'MODEL_NETWORK_OR_RESPONSE_ERROR'],
    [Response.json(response({status:'incomplete'})),'MODEL_INCOMPLETE'],
    [Response.json(response({model:'other'})),'MODEL_RESPONSE_MISMATCH'],
    [Response.json(response({output:[{type:'message',content:[{type:'refusal',refusal:'private'}]}]})),'MODEL_REFUSAL']];
  for(const [res,code] of cases) await assert.rejects(()=>new OpenAIResponses({OPENAI_API_KEY:'secret'},async()=>res).generate(request),
    e=>e instanceof ModelError&&e.code===code&&!String(e).includes('secret'));
});
test('missing cache telemetry remains unknown rather than invented zero',async()=>{
  const model=new OpenAIResponses({OPENAI_API_KEY:'secret'},async()=>Response.json(response({usage:{input_tokens:10,output_tokens:5}})));
  assert.equal((await model.generate(request)).usage?.cachedInputTokens,null);
});
test('output schema rejects score overflow, unknown fields and invalid country codes',()=>{
  const c=classification(crypto.randomUUID());
  assert.equal(rankingOutputSchema.safeParse({stories:[{...c,importanceScore:101}]}).success,false);
  assert.equal(rankingOutputSchema.safeParse({stories:[{...c,extra:'bad'}]}).success,false);
  assert.equal(rankingOutputSchema.safeParse({stories:[{...c,countries:['USA']}]}).success,false);
});
test('ranking sorts relevance/importance and persists metered results; replay does not call model',async()=>{
  const uid=await user(),id=crypto.randomUUID();let calls=0;
  const model=fake(async req=>{calls++;const context=JSON.parse(req.context);assert.deepEqual(Object.keys(context.preferences).sort(),['exclusions','regions','sources','topics']);
    assert.equal(context.messages,undefined);return fake().generate(req);});
  const result=await rankStories(db.runtime,model,uid,id,quality,limits,now);
  assert.equal(result.stories.length,2);assert.equal(result.stories[0]!.classification.userRelevanceScore,90);
  assert.ok(result.stories[0]!.candidate.sources.length);
  const replay=await rankStories(db.runtime,model,uid,id,quality,limits,now);assert.equal(replay.replayed,true);assert.equal(calls,1);
  const usage=await asUser(db.runtime,uid,tx=>tx.query<{estimated_cost_nanodollars:number;model:string;job_type:string}>(`SELECT * FROM ai_usage WHERE operation_id=$1`,[id]));
  assert.equal(Number(usage.rows[0]!.estimated_cost_nanodollars),42200);assert.equal(usage.rows[0]!.model,LUNA_MODEL);assert.equal(usage.rows[0]!.job_type,'news_ranking');
  const other=await user();assert.equal((await asUser(db.runtime,other,tx=>tx.query('SELECT * FROM job_runs WHERE id=$1',[id]))).rows.length,0);
});
test('budget and input bounds reject before provider or ledger attempt',async()=>{
  const uid=await user();let calls=0;const model=fake(async()=>{calls++;throw Error('must not run');});
  await assert.rejects(()=>rankStories(db.runtime,model,uid,crypto.randomUUID(),quality,{monthlyBudgetNanodollars:1n},now),/RANKING_BUDGET_EXCEEDED/);
  await assert.rejects(()=>rankStories(db.runtime,model,uid,crypto.randomUUID(),quality,{...limits,maxInputTokens:1024},now),/INPUT_TOKEN_LIMIT/);
  assert.equal(calls,0);assert.equal((await asUser(db.runtime,uid,tx=>tx.query('SELECT * FROM ai_usage'))).rows.length,0);
});
test('malformed output is failed but billed usage remains recorded and cannot replay',async()=>{
  const uid=await user(),id=crypto.randomUUID();const model=fake(async()=>({text:'not-json',usage:{inputTokens:10,cachedInputTokens:0,outputTokens:4},requestId:null}));
  await assert.rejects(()=>rankStories(db.runtime,model,uid,id,quality,limits,now),/MODEL_OUTPUT_OR_PROVIDER_ERROR/);
  await assert.rejects(()=>rankStories(db.runtime,model,uid,id,quality,limits,now),/ALREADY_ATTEMPTED/);
  const row=(await asUser(db.runtime,uid,tx=>tx.query<{status:string;estimated_cost_nanodollars:number}>('SELECT * FROM ai_usage'))).rows[0]!;
  assert.equal(row.status,'failed');assert.equal(Number(row.estimated_cost_nanodollars),6800);
});
test('missing, duplicate and invented cluster IDs fail structured validation',async()=>{
  for(const stories of [[],[classification(crypto.randomUUID())],quality.candidates.map(()=>classification(quality.candidates[0]!.clusterId))]) {
    const uid=await user();const model=fake(async()=>({text:JSON.stringify({stories}),usage:null,requestId:null}));
    await assert.rejects(()=>rankStories(db.runtime,model,uid,crypto.randomUUID(),quality,limits,now),/MODEL_(OUTPUT|CLUSTER_IDS)_INVALID/);
  }
});
test('timeout returns safely even for a provider that ignores abort; unknown cost stays reserved',async()=>{
  const uid=await user();const model=fake(()=>new Promise(()=>{}));
  await assert.rejects(()=>rankStories(db.runtime,model,uid,crypto.randomUUID(),quality,{...limits,timeoutMs:10},now),/MODEL_TIMEOUT/);
  const row=(await asUser(db.runtime,uid,tx=>tx.query<{status:string;reserved_cost_nanodollars:number;estimated_cost_nanodollars:null}>('SELECT * FROM ai_usage'))).rows[0]!;
  assert.equal(row.status,'unknown');assert.equal(row.estimated_cost_nanodollars,null);assert.ok(Number(row.reserved_cost_nanodollars)>0);
  await assert.rejects(()=>rankStories(db.runtime,fake(),uid,crypto.randomUUID(),quality,{monthlyBudgetNanodollars:6_000_000n},now),/BUDGET_EXCEEDED/);
});
test('provider errors are sanitized and ledger captures failed attempt',async()=>{
  const uid=await user();await assert.rejects(()=>rankStories(db.runtime,fake(async()=>{throw Error('secret provider URL');}),uid,crypto.randomUUID(),quality,limits,now),
    e=>!String(e).includes('secret')&&String(e).includes('MODEL_OUTPUT_OR_PROVIDER_ERROR'));
  assert.equal((await asUser(db.runtime,uid,tx=>tx.query('SELECT * FROM ai_usage'))).rows.length,1);
});
test('stale and unpersisted candidates never reach Luna',async()=>{
  const uid=await user();
  await assert.rejects(()=>rankStories(db.runtime,fake(),uid,crypto.randomUUID(),quality,limits,new Date('2026-09-20T12:00:00Z')),/CANDIDATE_NOT_FRESH/);
  await assert.rejects(()=>rankStories(db.runtime,fake(),uid,crypto.randomUUID(),{...quality,runId:crypto.randomUUID()},limits,now),/QUALITY_SNAPSHOT_STALE/);
});
test('retrieval diagnostics expose field names and allowance code, never arbitrary exception text',()=>{
  assert.equal(safeLiveError(new Error('COLLECTION_ALLOWANCE_EXCEEDED')),'COLLECTION_ALLOWANCE_EXCEEDED');
  assert.equal(safeLiveError(new LiveConfigError('Required field: RUN_LIVE_RETRIEVAL')),'Required field: RUN_LIVE_RETRIEVAL');
  assert.ok(!safeLiveError(new Error('https://private/?key=secret')).includes('secret'));
  assert.throws(()=>liveRetrievalConfig({BRAVE_API_KEY:'secret'}),e=>String(e).includes('RUN_LIVE_RETRIEVAL')&&!String(e).includes('secret'));
});
