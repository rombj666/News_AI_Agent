import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStories } from '../src/quality/pipeline.js';
import { qualityDiagnostic } from '../scripts/quality-diagnostic.js';
import type { QualityArticle } from '../src/quality/types.js';

test('live diagnostic explains stale and undated exclusions without exposing article content', () => {
  const article: QualityArticle = { id: 'old', canonicalUrl: 'https://example.com/private-path',
    title: 'Satellite launch reaches lunar orbit', sourceName: 'Example', sourceDomain: 'example.com',
    description: 'Sensitive article content', publishedAt: '2026-09-17T12:00:00Z',
    fetchedAt: '2026-09-23T12:00:00Z', lastSeenAt: '2026-09-23T12:00:00Z',
    dateKind: 'published', contentKind: 'feed_excerpt', aliases: [] };
  const result = prepareStories([article, { ...article, id: 'undated', publishedAt: null, dateKind: 'unknown' }],
    new Date('2026-09-23T13:00:00Z'));
  assert.equal(result.candidates.length, 0);
  assert.equal(qualityDiagnostic(result.statistics, result.config.windowHours),
    'Stored articles: 2\nFresh articles: 0\nClusters: 1\nEligible candidates: 0\n'
    + 'Reason: No eligible cluster has a fresh member within 24 hours. '
    + 'Excluded articles: stale=1, undated=1, uncertain date=0, future=0, invalid=0.');
});

test('live diagnostic distinguishes an empty database', () => {
  const result = prepareStories([], new Date('2026-09-23T13:00:00Z'));
  assert.match(qualityDiagnostic(result.statistics,24), /Reason: No stored articles\.$/);
});
