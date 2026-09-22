import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { localDatabase } from '../scripts/local-db.js';
import { canonicalUrl, normalizeArticle, parseDate } from '../src/retrieval/normalize.js';
import { persistArticle } from '../src/retrieval/repository.js';
import { prepareStories } from '../src/quality/pipeline.js';
import { qualityConfigSchema } from '../src/quality/config.js';
import { freshness } from '../src/quality/freshness.js';
import { refreshQuality } from '../src/quality/service.js';
import { QUALITY_NOW as now, qualityArticle as article, qualityFixtures } from './fixtures/quality.js';
import type { QualityArticle } from '../src/quality/types.js';

test('extended URL normalization handles tracking, percent paths, dot segments and original URL preservation', async () => {
  assert.equal(canonicalUrl('https://EXAMPLE.com.:443/a/../%7enews/%2f?id=4&igshid=x&_gl=abc&utm_term=x#top'), 'https://example.com/~news/%2F?id=4');
  assert.equal(canonicalUrl('https://example.com/story?mkt_tok=x&_hsenc=y&ref=article-2'), 'https://example.com/story?ref=article-2');
  assert.notEqual(canonicalUrl('https://example.com/story/'),canonicalUrl('https://example.com/story'));
  const normalized = await normalizeArticle({ url:'https://example.com/story?fbclid=old',title:'Story',source:'Example',
    excerpt:'',publishedAt:null,fetchedAt:now.toISOString(),dateKind:'unknown',contentKind:'snippet',rawMetadata:{} });
  assert.equal(normalized.originalUrl,'https://example.com/story?fbclid=old');
  assert.equal(normalized.canonicalUrl,'https://example.com/story');
});

test('invalid calendar dates are rejected instead of rolled into the next month', () => {
  assert.equal(parseDate('2026-02-30T10:00:00Z'),null);
  assert.equal(parseDate('2026-13-01'),null);
  assert.equal(parseDate('Mon, 30 Feb 2026 10:00:00 GMT'),null);
  assert.equal(parseDate('2024-02-29T10:00:00Z'),'2024-02-29T10:00:00.000Z');
});

test('24h, 48h and 7d windows use publication time, with inclusive lower boundary', () => {
  const older = article(1,{ publishedAt:'2026-09-16T06:00:00Z',fetchedAt:now.toISOString(),lastSeenAt:now.toISOString() });
  assert.equal(freshness(older,now,qualityConfigSchema.parse({windowHours:24})),'stale');
  assert.equal(freshness(older,now,qualityConfigSchema.parse({windowHours:48})),'fresh');
  assert.equal(freshness(article(2,{publishedAt:'2026-09-11T12:00:00Z'}),now,qualityConfigSchema.parse({windowHours:168})),'fresh');
  assert.equal(freshness(article(3,{publishedAt:'2026-09-16T12:00:00Z'}),now,qualityConfigSchema.parse({})),'fresh');
});

test('missing, future, invalid and page-age dates cannot silently become fresh', () => {
  const config = qualityConfigSchema.parse({});
  assert.equal(freshness(article(1,{publishedAt:null}),now,config),'undated');
  assert.equal(freshness(article(1,{publishedAt:'tomorrow'}),now,config),'invalid_date');
  assert.equal(freshness(article(1,{publishedAt:'2026-09-18T00:00:00Z'}),now,config),'future');
  assert.equal(freshness(article(1,{dateKind:'page_age'}),now,config),'uncertain_date');
  assert.equal(freshness(article(1,{dateKind:'page_age'}),now,qualityConfigSchema.parse({allowPageAge:true})),'fresh');
});

test('cross-source paraphrases form one cluster with every source URL preserved', () => {
  const result=prepareStories(qualityFixtures().slice(0,3),now);
  assert.equal(result.clusters.length,1);
  assert.equal(result.statistics.nearDuplicates,2);
  assert.equal(result.candidates[0]!.sourceCount,3);
  assert.equal(result.candidates[0]!.sources.length,3);
});

test('same-source and cross-source exact title/URL duplicates keep best representative', () => {
  const pool=[article(1),article(2,{title:'OPENAI ANNOUNCES AURORA AI MODEL!',canonicalUrl:'https://other.example.com/2',description:'More comprehensive '.repeat(25)}),
    article(3,{canonicalUrl:'https://example.com/story/1?twclid=tracking',title:'Different headline at same URL'})];
  const result=prepareStories(pool,now);
  assert.equal(result.clusters.length,1);
  assert.equal(result.statistics.exactDuplicates,2);
  assert.equal(result.candidates[0]!.representative.id,pool[1]!.id);
  assert.equal(result.candidates[0]!.sourceCount,2);
});

test('similar generic words, different entities, opposite actions and model versions do not merge', () => {
  for (const [a,b] of [
    ['OpenAI launches Aurora AI model','Google launches Gemini AI model'],
    ['Microsoft partners with OpenAI on AI model','Microsoft partners with Google on AI model'],
    ['OpenAI launches Aurora AI model','OpenAI delays Aurora AI model'],
    ['OpenAI launches Aurora 5 AI model','OpenAI launches Aurora 6 AI model'],
    ['OpenAI launches Aurora AI model','OpenAI does not launch Aurora AI model'],
  ]) assert.equal(prepareStories([article(1,{title:a!}),article(2,{title:b!})],now).clusters.length,2,`${a} / ${b}`);
});

test('configurable threshold and complete-link matching prevent similarity chains', () => {
  const pool=[article(1,{title:'OpenAI launches Aurora coding model'}),article(2,{title:'OpenAI launches Aurora coding reasoning model'}),article(3,{title:'OpenAI launches Aurora reasoning model'})];
  assert.equal(prepareStories(pool,now,{titleThreshold:0.75}).clusters.length,2);
  assert.equal(prepareStories(pool,now,{titleThreshold:1}).clusters.length,3);
});

test('recurring headlines beyond story span remain separate; stale articles never become representatives', () => {
  const older=article(1,{publishedAt:'2026-09-10T10:00:00Z',fetchedAt:'2026-09-10T11:00:00Z',lastSeenAt:'2026-09-10T11:00:00Z',description:'Long detailed text '.repeat(50)});
  const recent=article(2);
  const result=prepareStories([older,recent],now);
  assert.equal(result.clusters.length,2);
  assert.equal(result.candidates.length,1);
  assert.equal(result.candidates[0]!.representative.id,recent.id);
  const nearby=article(3,{publishedAt:'2026-09-16T10:00:00Z',description:'More detail '.repeat(100)});
  const combined=prepareStories([nearby,recent],now);
  assert.equal(combined.candidates.length,1);
  assert.equal(combined.candidates[0]!.representative.id,recent.id);
  assert.equal(combined.candidates[0]!.sources.length,2);
  assert.equal(combined.candidates[0]!.sources.filter((entry)=>entry.freshness==='stale').length,1);
});

test('processing is input-order independent and excludes invalid/undated inputs with honest statistics', () => {
  const pool=qualityFixtures();
  const result=prepareStories(pool,now);
  assert.deepEqual(prepareStories([...pool].reverse(),now),result);
  assert.equal(result.statistics.undatedArticles,1);
  assert.equal(result.statistics.invalidArticles,1);
  assert.equal(result.statistics.futureArticles,1);
  assert.equal(result.statistics.uncertainDateArticles,1);
  assert.equal(result.candidates.length,4);
  assert.ok(result.candidates.every((candidate)=>freshness(candidate.representative,now,result.config)==='fresh'));
  assert.throws(()=>prepareStories(pool,now,{maxArticles:2}),/POOL_LIMIT/);
  assert.throws(()=>prepareStories(pool,now,{windowHours:0}));
});

let db: Awaited<ReturnType<typeof localDatabase>>;
before(async()=>{ db=await localDatabase(); });
after(async()=>{ await db?.close(); });

async function store(item: QualityArticle) {
  const normalized=await normalizeArticle({url:item.canonicalUrl,title:item.title,source:item.sourceName,
    excerpt:item.description,publishedAt:item.publishedAt,fetchedAt:item.fetchedAt,dateKind:item.dateKind,contentKind:item.contentKind,rawMetadata:{}});
  return db.collector.transaction((tx)=>persistArticle(tx,normalized));
}

test('persisted clusters update with newer coverage, stable ID, best representative and all links', async()=>{
  const a=article(101,{canonicalUrl:'https://one.example.com/aurora',fetchedAt:'2026-09-17T09:00:00Z'});
  const first=await store(a);
  const initial=await refreshQuality(db.quality,now);
  assert.equal(initial.clusters.length,1);
  const clusterId=initial.clusters[0]!.id;
  assert.equal(initial.clusters[0]!.representative.id,first.id);
  const b=article(102,{canonicalUrl:'https://two.example.com/aurora',title:'OpenAI unveils Aurora AI model',
    publishedAt:'2026-09-17T10:00:00Z',fetchedAt:'2026-09-17T11:00:00Z',lastSeenAt:'2026-09-17T11:00:00Z',description:'Detailed coverage '.repeat(20)});
  const second=await store(b);
  const updated=await refreshQuality(db.quality,now);
  assert.equal(updated.clusters[0]!.id,clusterId);
  assert.equal(updated.candidates[0]!.representative.id,second.id);
  assert.equal(updated.clusters[0]!.sourceCount,2);
  assert.equal(updated.clusters[0]!.articleCount,2);
  assert.equal(updated.clusters[0]!.latestSeenAt,'2026-09-17T11:00:00.000Z');
  assert.equal((await db.runtime.query('SELECT * FROM article_cluster_members')).rows.length,2);
  const repeated=await refreshQuality(db.quality,now);
  assert.deepEqual(repeated.clusters,updated.clusters);
  assert.deepEqual(repeated.candidates,updated.candidates);
});

test('repeat retrieval updates last seen without refreshing an old publication date', async()=>{
  const old=article(103,{canonicalUrl:'https://old.example.com/story',title:'Historic ocean research findings',publishedAt:'2026-09-01T01:00:00Z',fetchedAt:'2026-09-01T02:00:00Z'});
  const saved=await store(old);
  await store({...old,fetchedAt:now.toISOString(),publishedAt:now.toISOString()});
  const row=await db.owner.query<{published_at:Date;last_seen_at:Date}>('SELECT published_at,last_seen_at FROM articles WHERE id=$1',[saved.id]);
  assert.equal(row.rows[0]!.published_at.toISOString(),'2026-09-01T01:00:00.000Z');
  assert.equal(row.rows[0]!.last_seen_at.toISOString(),now.toISOString());
  const result=await refreshQuality(db.quality,now);
  assert.ok(!result.candidates.some((candidate)=>candidate.representative.id===saved.id));
});

test('confirmed publication can replace missing date without losing article identity', async()=>{
  const unknown=article(104,{canonicalUrl:'https://recover.example.com/story',title:'Ocean researchers locate deep reef',publishedAt:null,dateKind:'unknown'});
  const saved=await store(unknown);
  const updated=await store({...unknown,publishedAt:'2026-09-17T10:00:00Z',fetchedAt:'2026-09-17T11:00:00Z',dateKind:'published'});
  assert.equal(updated.id,saved.id);
  assert.equal(updated.duplicate,true);
  const quality=await refreshQuality(db.quality,now);
  assert.ok(quality.candidates.some((candidate)=>candidate.representative.id===saved.id));
});

test('bounded quality failure leaves last successful clusters intact; runtime cannot mutate them', async()=>{
  const beforeRows=await db.runtime.query('SELECT * FROM story_clusters ORDER BY id');
  await assert.rejects(()=>refreshQuality(db.quality,now,{maxArticles:1}),/POOL_LIMIT/);
  assert.deepEqual((await db.runtime.query('SELECT * FROM story_clusters ORDER BY id')).rows,beforeRows.rows);
  await assert.rejects(()=>db.runtime.query('DELETE FROM story_clusters'));
  await assert.rejects(()=>db.quality.query('SELECT * FROM messages'));
  await assert.rejects(()=>db.quality.query('SELECT * FROM retrieval_runs'));
});
