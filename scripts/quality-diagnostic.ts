import type { QualityStatistics } from '../src/quality/types.js';

// Accept only counters/configuration: never serialize articles or provider errors.
export function qualityDiagnostic(stats: QualityStatistics, windowHours: number): string {
  const reason = stats.rawArticles === 0 ? 'No stored articles.'
    : stats.finalCandidates > 0 ? 'Fresh candidates available.'
    : `No eligible cluster has a fresh member within ${windowHours} hours. `
      + `Excluded articles: stale=${stats.staleArticles}, undated=${stats.undatedArticles}, `
      + `uncertain date=${stats.uncertainDateArticles}, future=${stats.futureArticles}, invalid=${stats.invalidArticles}.`;
  return [`Stored articles: ${stats.rawArticles}`, `Fresh articles: ${stats.freshArticles}`,
    `Clusters: ${stats.storyClusters}`, `Eligible candidates: ${stats.finalCandidates}`, `Reason: ${reason}`].join('\n');
}
