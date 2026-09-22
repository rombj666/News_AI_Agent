import { parseDate } from '../retrieval/normalize.js';
import type { QualityConfig } from './config.js';
import type { Freshness, QualityArticle } from './types.js';

export function freshness(article: QualityArticle, now: Date, config: QualityConfig): Freshness {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid evaluation time');
  if (!article.publishedAt) return 'undated';
  const published = parseDate(article.publishedAt);
  if (!published) return 'invalid_date';
  const time = Date.parse(published);
  if (time > now.getTime()) return 'future';
  if (article.dateKind === 'unknown') return 'uncertain_date';
  if (article.dateKind === 'page_age' && !config.allowPageAge) return 'uncertain_date';
  return time >= now.getTime() - config.windowHours * 3_600_000 ? 'fresh' : 'stale';
}
