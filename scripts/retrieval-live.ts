import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { localDatabase } from './local-db.js';
import { liveRetrievalConfig } from '../src/retrieval/live-config.js';
import { safeLiveError } from '../src/retrieval/live-errors.js';
import { parseRssSources } from '../src/retrieval/sources.js';
import { RssRetriever } from '../src/retrieval/rss.js';
import { BraveRetriever } from '../src/retrieval/brave.js';
import { collectNews, type RunRecord } from '../src/retrieval/collect.js';

async function main() {
  if (process.env.RUN_LIVE_RETRIEVAL !== 'YES') throw new Error('LIVE_OPT_IN_REQUIRED');
  const mode = process.env.LIVE_RETRIEVAL_PROVIDER ?? 'both';
  if (!['rss','brave','both'].includes(mode)) throw new Error('LIVE_PROVIDER_INVALID');
  const config = mode === 'rss' ? null : liveRetrievalConfig(process.env);
  const sources = parseRssSources(JSON.parse(await readFile(new URL('../config/rss-sources.json', import.meta.url), 'utf8')));
  const source = sources.find(s => s.id === process.env.LIVE_RSS_SOURCE_ID && s.enabled);
  if (mode !== 'brave' && !source) throw new Error('RSS_SOURCE_NOT_ENABLED');
  const directory = new URL('../.local/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const db = await localDatabase(fileURLToPath(new URL('retrieval-live-db', directory)));
  const report = async (provider: string, run: () => Promise<RunRecord>) => {
    try {
      const r = await run();
      console.log(JSON.stringify({provider,runId:r.id,status:r.status,fetched:r.number_fetched,inserted:r.number_inserted,
        duplicates:r.number_duplicates,filtered:r.number_filtered,failures:r.number_failures,
        failureCodes:r.failures.map(f => /^([A-Z_]+|HTTP_\d{3})$/.test(f.code) ? f.code : 'PROVIDER_FAILURE'),
        estimatedCostNanodollars:r.estimated_cost_nanodollars}));
      if(r.status !== 'succeeded') process.exitCode=1;
    } catch(error) { console.error(JSON.stringify({provider,error:safeLiveError(error)})); process.exitCode=1; }
  };
  try {
    const since = new Date(Date.now()-7*86_400_000);
    if(mode !== 'brave') await report('rss',()=>collectNews(db.collector,new RssRetriever(source!),{
      runId:crypto.randomUUID(),source:source!,since,category:source!.category,limit:10}));
    if(config) await report('brave',()=>collectNews(db.collector,new BraveRetriever(config.braveKey),{
      runId:crypto.randomUUID(),query:config.query,since,category:'live-test',limit:3},{limits:config.limits}));
    console.log('Results stored in .local/retrieval-live-db. No model or delivery calls.');
  } finally { await db.close(); }
}
main().catch(error=>{ console.error(safeLiveError(error)); process.exitCode=1; });
