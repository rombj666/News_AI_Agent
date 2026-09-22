import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { localDatabase } from '../scripts/local-db.js';
import { asUser } from '../src/db/database.js';
import { createUser } from '../src/services/identity.js';
import { RssRetriever } from '../src/retrieval/rss.js';
import { BraveRetriever } from '../src/retrieval/brave.js';
import { collectNews, type CollectionLimits, type CollectionRequest } from '../src/retrieval/collect.js';
import { canonicalUrl, normalizeArticle, parseDate, plainText } from '../src/retrieval/normalize.js';
import { parseRssSources, type RssSource } from '../src/retrieval/sources.js';
import { fetchText, type Fetcher } from '../src/retrieval/http.js';
import { liveRetrievalConfig } from '../src/retrieval/live-config.js';
import type { NewsCandidate, NewsRetriever, RetrievalRequest } from '../src/domain/ports.js';

const clock = { now: () => new Date('2026-09-17T01:00:00Z') };
const since = new Date('2026-09-16T01:00:00Z');
const source: RssSource = { id: 'example-science', name: 'Example Science', url: 'https://example.com/feed.xml', category: 'science', enabled: true };
const limits: CollectionLimits = { braveCostPerRequest: 5_000_000n, pricingVersion: 'test-fixture-rate', monthlyBudget: 1_000_000_000n, dailyRequests: 100 };
let rss: string;
let atom: string;
let brave: string;
let db: Awaited<ReturnType<typeof localDatabase>>;

before(async () => {
  [rss, atom, brave] = await Promise.all(['rss.xml', 'atom.xml', 'brave.json'].map((name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))) as [string, string, string];
  db = await localDatabase();
});
after(async () => { await db?.close(); });

const response = (text: string, status = 200, headers: Record<string, string> = {}): Fetcher => async () => new Response(text, { status, headers });
const request = (): RetrievalRequest => ({ query: 'AI news', since, limit: 20, signal: new AbortController().signal });
const rssRun = (extra: Partial<CollectionRequest> = {}): CollectionRequest => ({ runId: crypto.randomUUID(), source, since, category: 'science', blockedDomains: ['blocked.example.com'], ...extra });
const braveRun = (extra: Partial<CollectionRequest> = {}): CollectionRequest => ({ runId: crypto.randomUUID(), query: 'AI news', since, category: 'ai', limit: 20, ...extra });

test('normal test entrypoint blocks network even if API keys exist', async () => {
  await assert.rejects(() => fetch('https://example.com'), /Network disabled/);
});

test('RSS configuration is explicit, unique, disabled by default and rejects private/credential URLs', async () => {
  const config = parseRssSources(JSON.parse(await readFile(new URL('../config/rss-sources.json', import.meta.url), 'utf8')));
  assert.ok(config.length > 0);
  assert.ok(config.every((entry) => !entry.enabled));
  assert.throws(() => parseRssSources([source, source]));
  for (const url of ['http://example.com/feed', 'https://127.0.0.1/rss', 'https://localhost/rss', 'https://user:password@example.com/rss']) {
    assert.throws(() => parseRssSources([{ ...source, url }]));
  }
});

test('RSS parses bounded items, descriptions, dates and bad-item failures', async () => {
  const batch = await new RssRetriever(source, response(rss), clock).collect(request());
  assert.equal(batch.fetched, 8);
  assert.equal(batch.items.length, 7);
  assert.deepEqual(batch.failures, [{ code: 'INVALID_FEED_ITEM', index: 5 }]);
  assert.equal(batch.items[0]!.publishedAt, '2026-09-17T00:00:00.000Z');
  assert.match(batch.items[0]!.excerpt, /<b>new chips<\/b>/);
  assert.equal(batch.items[4]!.publishedAt, null);
  assert.equal(batch.items[4]!.dateKind, 'unknown');
  assert.equal((await new RssRetriever(source, response(rss), clock).collect({ ...request(), limit: 2 })).fetched, 2);
});

test('Atom resolves alternate/relative links and does not treat updated as published', async () => {
  const batch = await new RssRetriever(source, response(atom), clock).collect(request());
  assert.equal(batch.items[0]!.url, 'https://example.com/story/2');
  assert.equal(batch.items[1]!.url, 'https://example.com/story/3');
  assert.equal(batch.items[1]!.publishedAt, null);
  assert.equal(plainText(batch.items[0]!.excerpt), 'Atom summary');
});

test('feed fetch sends validators and handles 304 without parsing or duplicate insertion', async () => {
  const mock: Fetcher = async (url, init) => {
    assert.equal(url, source.url);
    assert.equal(new Headers(init.headers).get('if-none-match'), 'abc');
    assert.equal(new Headers(init.headers).get('if-modified-since'), 'yesterday');
    assert.equal(init.redirect, 'error');
    return new Response(null, { status: 304 });
  };
  const batch = await new RssRetriever(source, mock, clock).collect({ ...request(), etag: 'abc', lastModified: 'yesterday' });
  assert.equal(batch.notModified, true);
  assert.equal(batch.fetched, 0);
});

test('malformed XML, unsupported feeds, DTD/entity declarations and disabled feeds fail safely', async () => {
  for (const text of ['<rss><broken></rss>', '<html>not a feed</html>', '<!DOCTYPE rss [<!ENTITY leak SYSTEM "file:///secret">]><rss/>']) {
    await assert.rejects(() => new RssRetriever(source, response(text), clock).collect(request()));
  }
  let calls = 0;
  await assert.rejects(() => new RssRetriever({ ...source, enabled: false }, async () => { calls++; return new Response(rss); }, clock).collect(request()), /SOURCE_DISABLED/);
  assert.equal(calls, 0);
});

test('Brave uses one News API call, authentication header and bounded parameters', async () => {
  let calls = 0;
  const mock: Fetcher = async (url, init) => {
    calls++;
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, 'https://api.search.brave.com/res/v1/news/search');
    assert.equal(parsed.searchParams.get('q'), 'AI news');
    assert.equal(parsed.searchParams.get('count'), '20');
    assert.equal(parsed.searchParams.get('freshness'), '2026-09-16to2026-09-17');
    assert.equal(new Headers(init.headers).get('x-subscription-token'), 'test-key');
    assert.equal(init.redirect, 'error');
    return new Response(brave);
  };
  const batch = await new BraveRetriever('test-key', mock, clock).collect(request());
  assert.equal(calls, 1);
  assert.equal(batch.fetched, 4);
  assert.equal(batch.items.length, 3);
  assert.equal(batch.failures.length, 1);
  assert.equal(batch.items[0]!.dateKind, 'page_age');
  assert.equal(batch.items[2]!.publishedAt, null, 'relative age must not become an invented timestamp');
});

test('bad Brave responses, rate limits, timeouts and oversize bodies fail without exposing provider text', async () => {
  await assert.rejects(() => new BraveRetriever('key', response('{bad json'), clock).collect(request()), /INVALID_BRAVE_RESPONSE/);
  await assert.rejects(() => new BraveRetriever('key', response('{}'), clock).collect(request()), /INVALID_BRAVE_RESPONSE/);
  await assert.rejects(() => new BraveRetriever('key', response('secret-provider-body', 429), clock).collect(request()), /^RetrievalError: HTTP_429$/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(() => fetchText(response(''), 'https://example.com', {}, aborted.signal), /ABORTED_OR_TIMEOUT/);
  await assert.rejects(() => fetchText(response('too large'), 'https://example.com', {}, request().signal, 3), /RESPONSE_TOO_LARGE/);
  await assert.rejects(() => new BraveRetriever('key', async () => { throw new Error('secret-key and private-query'); }, clock).collect(request()), /^RetrievalError: NETWORK_OR_ENCODING_ERROR$/);
});

test('canonical URLs strip tracking/fragments while preserving content queries and path semantics', () => {
  assert.equal(canonicalUrl('https://EXAMPLE.com:443/news?id=2&utm_source=x&b=1#fragment'), 'https://example.com/news?b=1&id=2');
  assert.notEqual(canonicalUrl('https://example.com/news?id=2'), canonicalUrl('https://example.com/news?id=3'));
  assert.notEqual(canonicalUrl('https://example.com/A'), canonicalUrl('https://example.com/a'));
  assert.notEqual(canonicalUrl('https://example.com/news'), canonicalUrl('https://example.com/news/'));
  assert.throws(() => canonicalUrl('javascript:alert(1)'));
  assert.throws(() => canonicalUrl('https://a:b@example.com/news'));
  assert.equal(parseDate('2 days ago'), null);
  assert.equal(parseDate('2026-09-17T00:00:00'), null);
});

test('title hashes normalize punctuation/case but separate publishers and publication days', async () => {
  const candidate: NewsCandidate = { url: 'https://example.com/a', title: 'New AI chips!', source: 'Example', excerpt: '<p>Hello &amp; goodbye</p>',
    publishedAt: '2026-09-17T00:00:00Z', fetchedAt: clock.now().toISOString(), contentKind: 'snippet', dateKind: 'published', rawMetadata: {} };
  const a = await normalizeArticle(candidate);
  assert.equal(a.description, 'Hello & goodbye');
  assert.equal(a.titleHash, (await normalizeArticle({ ...candidate, title: 'NEW  AI CHIPS', url: 'https://www.example.com/b' })).titleHash);
  assert.notEqual(a.titleHash, (await normalizeArticle({ ...candidate, url: 'https://other.example.com/a' })).titleHash);
  assert.notEqual(a.titleHash, (await normalizeArticle({ ...candidate, publishedAt: '2026-09-16T00:00:00Z' })).titleHash);
});

test('RSS persistence counts fetched/inserted/duplicate/filtered/failures and records source metadata', async () => {
  const run = await collectNews(db.collector, new RssRetriever(source, response(rss, 200, { etag: 'v1' }), clock), rssRun(), { clock });
  assert.equal(run.status, 'partial');
  assert.equal(run.number_fetched, 8);
  assert.equal(run.number_inserted, 2);
  assert.equal(run.number_duplicates, 2);
  assert.equal(run.number_filtered, 3);
  assert.equal(run.number_failures, 1);
  assert.equal(run.estimated_cost_nanodollars, '0');
  const articles = await db.owner.query<{ canonical_url: string; description: string; published_at: Date | null }>('SELECT * FROM articles ORDER BY canonical_url');
  assert.equal(articles.rows.length, 2);
  assert.equal(articles.rows[0]!.description, 'Scientists announce new chips.');
  assert.equal(articles.rows[1]!.published_at, null);
  const storedSource = await db.owner.query<{ etag: string }>('SELECT etag FROM sources WHERE id=$1', [source.id]);
  assert.equal(storedSource.rows[0]!.etag, 'v1');
  const provenance = await db.owner.query('SELECT * FROM article_retrievals WHERE run_id=$1', [run.id]);
  assert.equal(provenance.rows.length, 4);
});

test('repeat collection deduplicates and same run ID never re-fetches; mismatched reuse is rejected', async () => {
  let calls = 0;
  const provider = new RssRetriever(source, async () => { calls++; return new Response(rss); }, clock);
  const input = rssRun();
  const first = await collectNews(db.collector, provider, input, { clock });
  assert.equal(first.number_inserted, 0);
  assert.equal(first.number_duplicates, 4);
  const same = await collectNews(db.collector, provider, input, { clock });
  assert.equal(same.id, first.id);
  assert.equal(calls, 1);
  await assert.rejects(() => collectNews(db.collector, provider, { ...input, limit: 1 }, { clock }), /Run ID reused/);
});

test('URL alias remains deduplicated after the alias title changes', async () => {
  const xml = '<rss><channel><item><title>Revised headline</title><link>https://example.com/news/alias</link><pubDate>Thu, 17 Sep 2026 00:00:00 GMT</pubDate></item></channel></rss>';
  const run = await collectNews(db.collector, new RssRetriever(source, response(xml), clock), rssRun(), { clock });
  assert.equal(run.number_inserted, 0);
  assert.equal(run.number_duplicates, 1);
});

test('stored feed validators are reused and a 304 run has zero new/duplicate articles', async () => {
  await collectNews(db.collector, new RssRetriever(source, response('<rss><channel/></rss>', 200, { etag: 'cached' }), clock), rssRun(), { clock });
  const mock: Fetcher = async (_url, init) => {
    assert.equal(new Headers(init.headers).get('if-none-match'), 'cached');
    return new Response(null, { status: 304 });
  };
  const run = await collectNews(db.collector, new RssRetriever(source, mock, clock), rssRun(), { clock });
  assert.equal(run.number_fetched, 0);
  assert.equal(run.number_duplicates, 0);
  assert.equal(run.status, 'succeeded');
});

test('changing collection filters invalidates feed validators and cache keys do not expose selection details', async () => {
  const mock: Fetcher = async (_url, init) => {
    assert.equal(new Headers(init.headers).get('if-none-match'), null);
    return new Response('<rss><channel/></rss>', { headers: { etag: 'new-filter' } });
  };
  await collectNews(db.collector, new RssRetriever(source, mock, clock), rssRun({ blockedDomains: ['private-filter.example.com'] }), { clock });
  const stored = await db.owner.query<{ cache_key: string }>('SELECT cache_key FROM sources WHERE id=$1', [source.id]);
  assert.match(stored.rows[0]!.cache_key, /^[0-9a-f]{64}$/);
  await assert.rejects(() => collectNews(db.collector, new RssRetriever(source, mock, clock), rssRun({ source: { ...source, id: 'different' } }), { clock }), /does not match/);
});

test('network timeout finishes the run with one failure and does not retry', async () => {
  let calls = 0;
  const mock: Fetcher = async (_url, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mock deadline exceeded')), 1000);
      init.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    });
  };
  const run = await collectNews(db.collector, new RssRetriever(source, mock, clock), rssRun(), { clock, timeoutMs: 10 });
  assert.equal(run.status, 'failed');
  assert.deepEqual(run.failures, [{ code: 'ABORTED_OR_TIMEOUT' }]);
  assert.equal(calls, 1);
});

test('Brave settlement reuses ai_usage and does not duplicate shared spend', async () => {
  let calls = 0;
  const provider = new BraveRetriever('key', async () => { calls++; return new Response(brave); }, clock);
  const input = braveRun();
  const run = await collectNews(db.collector, provider, input, { limits, clock });
  assert.equal(run.number_inserted, 2);
  assert.equal(run.number_duplicates, 1);
  assert.equal(run.number_failures, 1);
  assert.equal(run.estimated_cost_nanodollars, '5000000');
  await collectNews(db.collector, provider, input, { limits, clock });
  assert.equal(calls, 1);
  const ledger = await db.owner.query<{ status: string; estimated_cost_nanodollars: string; scope: string }>('SELECT status, estimated_cost_nanodollars::text, scope FROM ai_usage WHERE operation_id=$1', [run.id]);
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0]!.status, 'succeeded');
  assert.equal(ledger.rows[0]!.scope, 'shared');
  assert.equal(ledger.rows[0]!.estimated_cost_nanodollars, '5000000');
});

test('failed request retains reserved cost, safe failure code and unknown ledger usage', async () => {
  const run = await collectNews(db.collector, new BraveRetriever('secret', response('private body', 500), clock), braveRun(), { limits, clock });
  assert.equal(run.status, 'failed');
  assert.equal(run.estimated_cost_nanodollars, null);
  assert.equal(run.reserved_cost_nanodollars, '5000000');
  assert.deepEqual(run.failures, [{ code: 'HTTP_500' }]);
  const ledger = await db.owner.query<{ status: string; cost: string | null }>('SELECT status, estimated_cost_nanodollars::text AS cost FROM ai_usage WHERE operation_id=$1', [run.id]);
  assert.equal(ledger.rows[0]!.status, 'unknown');
  assert.equal(ledger.rows[0]!.cost, null);
});

test('account budget and daily request limits block fetching before spending', async () => {
  let calls = 0;
  const provider = new BraveRetriever('key', async () => { calls++; return new Response(brave); }, clock);
  await assert.rejects(() => collectNews(db.collector, provider, braveRun(), { clock, limits: { ...limits, monthlyBudget: 5_000_000n } }), /ALLOWANCE_EXCEEDED/);
  await assert.rejects(() => collectNews(db.collector, provider, braveRun(), { clock, limits: { ...limits, dailyRequests: 1 } }), /ALLOWANCE_EXCEEDED/);
  assert.equal(calls, 0);
});

test('private query/provenance is isolated while public articles are shared read-only', async () => {
  const alice = await createUser(db.owner, '80001');
  const bob = await createUser(db.owner, '80002');
  const run = await collectNews(db.collector, new BraveRetriever('key', response(brave), clock), braveRun({ userId: alice, query: 'private research topic' }), { limits, clock });
  const aliceRows = await asUser(db.runtime, alice, (tx) => tx.query('SELECT * FROM retrieval_runs WHERE id=$1', [run.id]));
  const bobRows = await asUser(db.runtime, bob, (tx) => tx.query('SELECT * FROM retrieval_runs WHERE id=$1', [run.id]));
  assert.equal(aliceRows.rows.length, 1);
  assert.equal(bobRows.rows.length, 0);
  assert.equal((await asUser(db.runtime, bob, (tx) => tx.query('SELECT * FROM article_retrievals WHERE run_id=$1', [run.id]))).rows.length, 0);
  assert.ok((await db.runtime.query('SELECT * FROM articles')).rows.length > 0);
  await assert.rejects(() => db.runtime.query("UPDATE articles SET title='bad'"));
  await assert.rejects(() => db.collector.query('SELECT * FROM messages'));
});

test('database failure rolls back settlement but leaves write-ahead run and ledger for reconciliation', async () => {
  const broken: NewsRetriever = {
    provider: 'brave',
    collect: async () => {
      await db.owner.exec("CREATE FUNCTION fail_article_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER fail_article BEFORE INSERT ON articles FOR EACH ROW EXECUTE FUNCTION fail_article_test();");
      return { items: [{ url: 'https://failure.example.com/new', title: 'Must roll back', source: 'Fail', excerpt: '', publishedAt: null, fetchedAt: clock.now().toISOString(), dateKind: 'unknown', contentKind: 'snippet', rawMetadata: {} }], fetched: 1, failures: [], notModified: false, etag: null, lastModified: null };
    },
  };
  const input = braveRun();
  try {
    await assert.rejects(() => collectNews(db.collector, broken, input, { clock, limits }), /test failure/);
  } finally { await db.owner.exec('DROP TRIGGER fail_article ON articles; DROP FUNCTION fail_article_test();'); }
  const run = await db.owner.query<{ status: string }>('SELECT status FROM retrieval_runs WHERE id=$1', [input.runId]);
  assert.equal(run.rows[0]!.status, 'running');
  assert.equal((await db.owner.query('SELECT * FROM article_retrievals WHERE run_id=$1', [input.runId])).rows.length, 0);
  assert.equal((await db.owner.query<{ status: string }>('SELECT status FROM ai_usage WHERE operation_id=$1', [input.runId])).rows[0]!.status, 'unknown');
});

test('live-test guard requires explicit consent, source, key and configured price/budget', () => {
  assert.throws(() => liveRetrievalConfig({}), /Live retrieval disabled/);
  assert.throws(() => liveRetrievalConfig({ RUN_LIVE_RETRIEVAL: 'YES', BRAVE_API_KEY: 'secret-value' }), (error: Error) => {
    assert.doesNotMatch(error.message, /secret-value/); return true;
  });
  const env = { RUN_LIVE_RETRIEVAL: 'YES', LIVE_RSS_SOURCE_ID: source.id, BRAVE_API_KEY: 'fixture-key', LIVE_BRAVE_QUERY: 'AI', BRAVE_COST_PER_REQUEST_NANODOLLARS: '5000000', BRAVE_PRICING_VERSION: 'test', RETRIEVAL_MONTHLY_BUDGET_NANODOLLARS: '10000000' };
  assert.equal(liveRetrievalConfig(env).limits.monthlyBudget, 10_000_000n);
  assert.throws(() => liveRetrievalConfig({ ...env, RETRIEVAL_MONTHLY_BUDGET_NANODOLLARS: '1' }), /exceeds/);
});
