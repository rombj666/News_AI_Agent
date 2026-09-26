import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { localDatabase } from '../scripts/local-db.js';
import { asUser, type Database } from '../src/db/database.js';
import { createUser } from '../src/services/identity.js';
import { readPreferences, proposePreferences, decideProposal } from '../src/services/preferences.js';
import { initialPreferences } from '../src/domain/preferences.js';
import { LUNA_MODEL } from '../src/config/index.js';
import { ModelError } from '../src/ai/openai.js';
import type { LanguageModel } from '../src/domain/ports.js';
import { generateDigest, readDigest, type DigestRequest } from '../src/digest/service.js';
import { loadRankedStories } from '../src/digest/ranked-stories.js';
import { selectDigestStories } from '../src/digest/selection.js';
import { digestConfigSchema } from '../src/digest/config.js';
import { digestResponseSchema } from '../src/digest/schema.js';
import { digestLiveConfig } from '../src/digest/live-config.js';
import { renderDigest } from '../src/digest/render.js';
import type { RankedStory } from '../src/digest/types.js';
import { normalizeArticle } from '../src/retrieval/normalize.js';
import { persistArticle } from '../src/retrieval/repository.js';
import { DIGEST_NOW as now, DIGEST_START as periodStart, DIGEST_END as periodEnd,
  digestTestLimits as limits, digestFixtureModel as model, seedDigestRankings } from './fixtures/digest.js';

let db: Awaited<ReturnType<typeof localDatabase>>;
let identity = 71000;
before(async () => { db = await localDatabase(); });
after(async () => { await db?.close(); });
async function setup(): Promise<DigestRequest> {
  const userId = await createUser(db.owner,String(++identity));
  const rankingId = await seedDigestRankings(db,userId);
  return {userId,operationId:crypto.randomUUID(),rankingOperationIds:[rankingId],periodStart,periodEnd};
}
const run = (request: DigestRequest, provider = model, database = db.runtime) => generateDigest(database,provider,request,limits,{},now);
const fake = (generate: LanguageModel['generate']): LanguageModel => ({model:LUNA_MODEL,generate});
const digestUsage = (userId: string) => asUser(db.runtime,userId,tx => tx.query<{
  status:string;estimated_cost_nanodollars:string|null;input_tokens:number|null;output_tokens:number|null;cached_input_tokens:number|null;
  reserved_cost_nanodollars:number;job_type:string;execution_time_ms:number;
}>("SELECT *,estimated_cost_nanodollars::text FROM ai_usage WHERE job_type='news_digest'"));
function failQuery(database: Database, match: string): Database {
  return {...database,transaction:work => database.transaction(tx => work({...tx,query:async (sql,params) => {
    if (sql.includes(match)) throw Error('injected persistence failure');
    return tx.query(sql,params);
  }}))};
}

test('QUICK NORMAL DEEP choose configurable counts and enforce distinct story IDs', () => {
  const stories: RankedStory[] = Array.from({length:25},(_,i) => ({rankingOperationId:crypto.randomUUID(),headline:`Fictional report ${i}`,sources:[],
    classification:{clusterId:crypto.randomUUID(),primaryCategory:'world',secondaryCategories:[],region:'World',countries:[],importanceScore:i,
      userRelevanceScore:50,confidence:0.8,importanceReason:'Test',entities:[],topics:[]}}));
  for (const [type,count] of [['quick',5],['normal',12],['deep',20]] as const) {
    assert.equal(selectDigestStories([...stories,stories[0]!],initialPreferences(),type).length,count);
  }
  assert.equal(selectDigestStories(stories,initialPreferences(),'normal',{maxStories:3}).length,3);
  assert.equal(selectDigestStories(stories,initialPreferences(),'normal',{lengths:{normal:{stories:14,summaryCharacters:450,explanationCharacters:250}}}).length,14);
  const config = digestConfigSchema.parse({});
  assert.ok(config.lengths.quick.summaryCharacters < config.lengths.normal.summaryCharacters);
  assert.ok(config.lengths.normal.summaryCharacters < config.lengths.deep.summaryCharacters);
  assert.equal(digestResponseSchema(config,'quick',1).safeParse({items:[{clusterId:stories[0]!.classification.clusterId,
    summary:'x'.repeat(221),whyItMatters:'Example',evidence:[{articleId:crypto.randomUUID(),quote:'Example quote'}]}]}).success,false);
});

test('selection weights database topic/region priorities, excludes topics and emits no empty sections', async () => {
  const request = await setup();
  const current = await readPreferences(db.runtime,request.userId);
  const proposal = await proposePreferences(db.runtime,request.userId,{...current.document,topics:{Grants:5},regions:{Malaysia:5},exclusions:['AI']},{now:() => now});
  await decideProposal(db.runtime,request.userId,proposal.id,'confirm',{now:() => now});
  const result = await generateDigest(db.runtime,model,request,limits,{topStories:0},now);
  const digest = result.digest!;
  assert.equal(digest.outputStoryCount,3);
  assert.deepEqual(digest.sections.map(s => s.name),['Business','Malaysia','World']);
  assert.ok(digest.sections.every(s => s.items.length > 0));
  assert.equal(digest.preferenceVersion,2);
  assert.equal((await readPreferences(db.runtime,request.userId)).version,2);
});

test('zero-priority topic, region and source entries exclude matching stories deterministically', async () => {
  const request = await setup();
  const stories = await loadRankedStories(db.runtime,request.userId,request.rankingOperationIds,now,periodStart,periodEnd);
  assert.equal(selectDigestStories(stories,{...initialPreferences(),topics:{AI:0}},'normal').length,3);
  assert.equal(selectDigestStories(stories,{...initialPreferences(),regions:{Malaysia:0}},'normal').length,3);
  assert.equal(selectDigestStories(stories,{...initialPreferences(),sources:{'example.com':0}},'normal').length,0);
});

test('digest persists attributed items, bounded context and usage; renderer has ordered nonempty sections', async () => {
  const request = await setup();
  const result = await run(request,fake(async input => {
    const context = JSON.parse(input.context);
    assert.deepEqual(Object.keys(context).sort(),['digestType','language','length','stories','writingStyle']);
    assert.ok(context.stories.every((s:{sources:Record<string,unknown>[]}) => s.sources.every(source => !('url' in source))));
    assert.ok(input.responseSchema);
    return model.generate(input);
  }));
  const digest = result.digest!;
  assert.equal(digest.inputStoryCount,4); assert.equal(digest.outputStoryCount,4);
  assert.equal(digest.model,LUNA_MODEL);
  const stored = await readDigest(db.runtime,request.userId,digest.id);
  assert.deepEqual(stored,digest);
  const items = await asUser(db.runtime,request.userId,tx => tx.query('SELECT * FROM digest_items WHERE digest_id=$1 ORDER BY position',[digest.id]));
  assert.equal(items.rows.length,4);
  for (const item of digest.sections.flatMap(s => s.items)) {
    for (const source of item.sources) {
      const row = (await db.owner.query<{canonical_url:string;source_name:string}>('SELECT canonical_url,source_name FROM articles WHERE id=$1',[source.articleId])).rows[0]!;
      assert.equal(source.url,row.canonical_url); assert.equal(source.name,row.source_name);
    }
  }
  const usage = (await digestUsage(request.userId)).rows[0]!;
  assert.equal(usage.status,'succeeded'); assert.equal(usage.estimated_cost_nanodollars,'116000');
  assert.equal(usage.input_tokens,100); assert.equal(usage.output_tokens,80); assert.equal(usage.cached_input_tokens,0);
  assert.ok(Number(usage.execution_time_ms) >= 0);
  const rendered = renderDigest(digest);
  assert.match(rendered,/Morning Briefing/); assert.match(rendered,/Why it matters:/); assert.match(rendered,/4\. /);
});

test('completed period replays without billing; explicit force creates an auditable revision', async () => {
  const request = await setup(); let calls = 0;
  const provider = fake(async input => { calls++; return model.generate(input); });
  const first = await run(request,provider);
  const repeat = await run({...request,operationId:crypto.randomUUID()},provider);
  assert.equal(repeat.replayed,true); assert.equal(repeat.digest!.id,first.digest!.id); assert.equal(calls,1);
  const forcedRequest = {...request,force:true,operationId:crypto.randomUUID()};
  const forced = await run(forcedRequest,provider);
  assert.notEqual(forced.digest!.id,first.digest!.id); assert.equal(calls,2);
  await run(forcedRequest,provider); assert.equal(calls,2);
  assert.equal((await digestUsage(request.userId)).rows.length,2);
});

test('concurrent requests cannot generate duplicate digests, including force', async () => {
  const request = await setup(); let calls = 0;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release=resolve; });
  const started = new Promise<void>(resolve => { entered=resolve; });
  const provider = fake(async input => { calls++; entered(); await gate; return model.generate(input); });
  const running = run(request,provider);
  await started;
  try { await assert.rejects(() => run({...request,force:true,operationId:crypto.randomUUID()},provider),/DIGEST_ALREADY_ATTEMPTED/); }
  finally { release(); }
  await running;
  assert.equal(calls,1);
});

test('zero ranked stories and stale stories do not call the model or create a usage entry', async () => {
  const request = await setup(); let calls = 0;
  const provider = fake(async () => { calls++; throw Error('should not run'); });
  assert.equal((await run({...request,rankingOperationIds:[]},provider)).reason,'NO_ELIGIBLE_RANKED_STORIES');
  const later = new Date('2026-09-25T12:00:00Z');
  assert.equal((await generateDigest(db.runtime,provider,{...request,periodStart:new Date('2026-09-25T00:00:00Z'),periodEnd:new Date('2026-09-26T00:00:00Z')},limits,{},later)).digest,null);
  assert.equal(calls,0); assert.equal((await digestUsage(request.userId)).rows.length,0);
});

test('malformed outputs and foreign/missing/duplicate cluster IDs fail and preserve billed usage', async () => {
  for (const change of [
    () => 'not-json',
    (value: {items:Record<string,unknown>[]}) => JSON.stringify({items:value.items.slice(1)}),
    (value: {items:Record<string,unknown>[]}) => JSON.stringify({items:value.items.map(item => ({...item,clusterId:crypto.randomUUID()}))}),
    (value: {items:Record<string,unknown>[]}) => JSON.stringify({items:value.items.map(() => value.items[0])}),
  ]) {
    const request = await setup();
    await assert.rejects(() => run(request,fake(async input => {
      const response = await model.generate(input); return {...response,text:change(JSON.parse(response.text))};
    })),/DIGEST_(OUTPUT|CLUSTER_IDS)_INVALID|MODEL_OUTPUT_OR_PROVIDER_ERROR/);
    assert.equal((await digestUsage(request.userId)).rows[0]!.status,'failed');
    assert.equal(await readDigest(db.runtime,request.userId,request.operationId),null);
    await assert.rejects(() => run({...request,operationId:crypto.randomUUID()}),/DIGEST_ALREADY_ATTEMPTED/);
  }
});

test('fabricated evidence, source URLs and extra model fields are rejected', async () => {
  for (const change of [
    (item: Record<string,unknown>) => {item.evidence=[{articleId:crypto.randomUUID(),quote:'invented evidence'}];},
    (item: Record<string,unknown>) => {item.summary='Read https://invented.example/news';},
    (item: Record<string,unknown>) => {item.sourceUrl='https://invented.example';},
  ]) {
    const request = await setup();
    await assert.rejects(() => run(request,fake(async input => {
      const response = await model.generate(input),value = JSON.parse(response.text);
      change(value.items[0]); return {...response,text:JSON.stringify(value)};
    })),/DIGEST_(EVIDENCE_INVALID|GENERATED_LINK|OUTPUT_INVALID)/);
  }
});

test('provider timeout and error retain unknown reservations and sanitize errors', async () => {
  const request = await setup();
  await assert.rejects(() => generateDigest(db.runtime,fake(() => new Promise(() => {})),request,{...limits,timeoutMs:5},{},now),/MODEL_TIMEOUT/);
  const usage = (await digestUsage(request.userId)).rows[0]!;
  assert.equal(usage.estimated_cost_nanodollars,null); assert.equal(usage.input_tokens,null);
  assert.equal(usage.status,'unknown'); assert.ok(Number(usage.reserved_cost_nanodollars)>0);
  const other = await setup();
  await assert.rejects(() => run(other,fake(async () => {throw Error('secret provider payload');})),
    e => String(e).includes('MODEL_OUTPUT_OR_PROVIDER_ERROR') && !String(e).includes('secret'));
});

test('reported provider failures retain token charges; unknown cached usage remains unknown', async () => {
  const request = await setup();
  await assert.rejects(() => run(request,fake(async () => {throw new ModelError('MODEL_INCOMPLETE',{
    text:'',usage:{inputTokens:100,cachedInputTokens:10,outputTokens:20},requestId:'resp_fixture'});})),/MODEL_INCOMPLETE/);
  assert.equal((await digestUsage(request.userId)).rows[0]!.estimated_cost_nanodollars,'42200');
  const second = await setup();
  await run(second,fake(async input => ({...await model.generate(input),usage:{inputTokens:100,cachedInputTokens:null,outputTokens:20}})));
  assert.equal((await digestUsage(second.userId)).rows[0]!.estimated_cost_nanodollars,null);
});

test('monthly and token budgets reject before any billable attempt', async () => {
  const request = await setup(); let calls = 0;
  const provider = fake(async input => {calls++; return model.generate(input);});
  await assert.rejects(() => generateDigest(db.runtime,provider,request,{...limits,monthlyBudgetNanodollars:1n},{},now),/DIGEST_BUDGET_EXCEEDED/);
  await assert.rejects(() => generateDigest(db.runtime,provider,request,{...limits,maxInputTokens:1024},{},now),/INPUT_TOKEN_LIMIT/);
  assert.equal(calls,0); assert.equal((await digestUsage(request.userId)).rows.length,0);
});

test('failed item settlement rolls back digest, items and settlement; reservation blocks retries', async () => {
  const request = await setup(); let calls = 0;
  const provider = fake(async input => {calls++; return model.generate(input);});
  await assert.rejects(() => run(request,provider,failQuery(db.runtime,'INSERT INTO digest_items')),/injected persistence failure/);
  assert.equal(calls,1);
  assert.equal((await digestUsage(request.userId)).rows[0]!.status,'unknown');
  assert.equal((await digestUsage(request.userId)).rows[0]!.estimated_cost_nanodollars,null);
  assert.equal((await asUser(db.runtime,request.userId,tx => tx.query('SELECT * FROM digest_items'))).rows.length,0);
  assert.equal(await readDigest(db.runtime,request.userId,request.operationId),null);
  await assert.rejects(() => run({...request,force:true,operationId:crypto.randomUUID()},provider),/DIGEST_ALREADY_ATTEMPTED/);
  assert.equal(calls,1);
});

test('failed reservation is atomic and prevents provider invocation', async () => {
  const request = await setup(); let calls = 0;
  await assert.rejects(() => run(request,fake(async input => {calls++; return model.generate(input);}),failQuery(db.runtime,'INSERT INTO ai_usage')),/injected persistence failure/);
  assert.equal(calls,0);
  assert.equal((await asUser(db.runtime,request.userId,tx => tx.query('SELECT * FROM digests'))).rows.length,0);
  assert.equal((await digestUsage(request.userId)).rows.length,0);
});

test('ownership validation and RLS protect rankings, digests and item ownership keys', async () => {
  const first = await setup(), second = await setup();
  await assert.rejects(() => run({...second,rankingOperationIds:first.rankingOperationIds}),/DIGEST_RANKING_NOT_OWNED_OR_READY/);
  const result = await run(first);
  assert.equal(await readDigest(db.runtime,second.userId,result.digest!.id),null);
  assert.equal((await db.runtime.query('SELECT * FROM digests')).rows.length,0);
  assert.equal((await asUser(db.runtime,second.userId,tx => tx.query('SELECT * FROM digest_items'))).rows.length,0);
  const item = result.digest!.sections[0]!.items[0]!;
  await assert.rejects(() => db.owner.query(`INSERT INTO digest_items(user_id,digest_id,story_cluster_id,position,section,headline,summary,why_it_matters,metadata)
    VALUES($1,$2,$3,1,'test','test','test','test','{}')`,[second.userId,result.digest!.id,item.clusterId]),/foreign key/);
});

test('live digest gate requires separate consent, user and budget without leaking secrets', () => {
  assert.throws(() => digestLiveConfig({OPENAI_API_KEY:'secret-test-value',RUN_LIVE_OPENAI:'YES'}),
    e => String(e).includes('RUN_LIVE_DIGEST') && !String(e).includes('secret-test-value'));
  const config = digestLiveConfig({RUN_LIVE_DIGEST:'YES',OPENAI_API_KEY:'secret-test-value',LIVE_OPENAI_USER_ID:crypto.randomUUID(),
    OPENAI_DIGEST_MONTHLY_BUDGET_NANODOLLARS:'10000000'});
  assert.equal(config.force,false);
  assert.equal(config.limits.maxOutputTokens,2500);
});

test('input fitting reduces story count before generation without changing source snippets or making retries', async () => {
  const request = await setup(); let calls = 0;
  const result = await generateDigest(db.runtime,fake(async input => {
    calls++; return model.generate(input);
  }),request,{...limits,maxInputTokens:4500},{},now);
  assert.ok(result.digest!.inputStoryCount > 0 && result.digest!.inputStoryCount < 4);
  assert.equal(calls,1);
});

test('digest budget includes existing ranking charges and failed unknown digest reservations', async () => {
  const request = await setup();
  await asUser(db.runtime,request.userId,tx => tx.query(`UPDATE ai_usage SET estimated_cost_nanodollars=999999999
    WHERE job_type='news_ranking' AND user_id=$1`,[request.userId]));
  await assert.rejects(() => run(request),/DIGEST_BUDGET_EXCEEDED/);
  const second = await setup();
  await assert.rejects(() => generateDigest(db.runtime,fake(() => new Promise(() => {})),second,{...limits,timeoutMs:5},{},now),/MODEL_TIMEOUT/);
  await assert.rejects(() => generateDigest(db.runtime,model,{...second,force:true,operationId:crypto.randomUUID()},
    {...limits,monthlyBudgetNanodollars:20_000_000n},{},now),/DIGEST_BUDGET_EXCEEDED/);
});

test('clustered stories preserve multiple stored source names and links', async () => {
  const userId = await createUser(db.owner,String(++identity));
  await db.collector.transaction(async tx => persistArticle(tx,await normalizeArticle({
    url:'https://second.example.com/telescope',title:'Orbital lab publishes open telescope software',source:'Second Fictional News',
    excerpt:'The fictional Orbital lab released telescope software for researchers.',publishedAt:'2026-09-23T08:00:00Z',
    fetchedAt:now.toISOString(),dateKind:'published',contentKind:'feed_excerpt',rawMetadata:{}})));
  const rankingId = await seedDigestRankings(db,userId);
  const result = await run({userId,operationId:crypto.randomUUID(),rankingOperationIds:[rankingId],periodStart,periodEnd});
  const item = result.digest!.sections.flatMap(s => s.items).find(item => item.primaryCategory === 'technology')!;
  assert.equal(item.sources.length,2);
  assert.deepEqual(item.sources.map(s => s.name).sort(),['Fictional News','Second Fictional News']);
  assert.deepEqual(item.sources.map(s => s.url).sort(),['https://example.com/digest/0','https://second.example.com/telescope']);
});
