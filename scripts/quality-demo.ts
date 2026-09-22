import { localDatabase } from './local-db.js';
import { normalizeArticle } from '../src/retrieval/normalize.js';
import { persistArticle } from '../src/retrieval/repository.js';
import { prepareStories } from '../src/quality/pipeline.js';
import { refreshQuality } from '../src/quality/service.js';
import { QUALITY_NOW, qualityFixtures } from '../tests/fixtures/quality.js';

const raw = qualityFixtures();
const preview = prepareStories(raw, QUALITY_NOW);
console.log('OFFLINE QUALITY DEMO — fictional fixtures; no network or LLM calls.');
for (const [label, count] of [
  ['Raw articles',preview.statistics.rawArticles], ['Exact duplicates',preview.statistics.exactDuplicates],
  ['Near duplicates',preview.statistics.nearDuplicates], ['Stale articles',preview.statistics.staleArticles],
  ['Undated articles',preview.statistics.undatedArticles], ['Invalid articles',preview.statistics.invalidArticles],
  ['Uncertain dates',preview.statistics.uncertainDateArticles], ['Future articles',preview.statistics.futureArticles],
  ['Story clusters',preview.statistics.storyClusters], ['Final candidates',preview.statistics.finalCandidates],
]) console.log(`${label}: ${count}`);

const db = await localDatabase();
try {
  // The ingestion layer already eliminates some exact duplicates. Report this
  // separately from quality-pass statistics over the original fixture batch.
  for (const article of raw) {
    const normalized = await normalizeArticle({ url: article.canonicalUrl, title: article.title, source: article.sourceName,
      excerpt: article.description, publishedAt: article.publishedAt, fetchedAt: article.fetchedAt,
      dateKind: article.dateKind, contentKind: article.contentKind, rawMetadata: {} });
    await db.collector.transaction((tx) => persistArticle(tx,normalized));
  }
  const saved = await refreshQuality(db.quality, QUALITY_NOW);
  console.log(`\nStored pool after ingestion deduplication: ${saved.statistics.rawArticles}`);
  console.log(`Persisted clusters: ${saved.clusters.length}; candidates: ${saved.candidates.length}`);
  for (const candidate of saved.candidates) console.log(`- ${candidate.title} (${candidate.sourceCount} sources, ${candidate.articleCount} articles)`);
  console.log('Statistics overlap: stale members can remain as historical links inside a fresh cluster.');
} finally { await db.close(); }
