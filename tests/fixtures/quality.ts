import type { QualityArticle } from '../../src/quality/types.js';

export const QUALITY_NOW = new Date('2026-09-17T12:00:00Z');
export function qualityArticle(index: number, overrides: Partial<QualityArticle> = {}): QualityArticle {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,
    canonicalUrl: `https://example.com/story/${index}`,
    title: 'OpenAI announces Aurora AI model', sourceName: 'Example', sourceDomain: 'example.com',
    description: 'Details about the announcement.', publishedAt: '2026-09-17T08:00:00Z',
    fetchedAt: '2026-09-17T09:00:00Z', lastSeenAt: '2026-09-17T09:00:00Z',
    dateKind: 'published', contentKind: 'feed_excerpt', aliases: [], ...overrides,
  };
}

export function qualityFixtures(): QualityArticle[] {
  return [
    qualityArticle(1, { canonicalUrl: 'https://reuters.example.com/openai?utm_source=rss', sourceName: 'Reuters', sourceDomain: 'reuters.example.com' }),
    qualityArticle(2, { canonicalUrl: 'https://bbc.example.com/openai', title: 'OpenAI launches Aurora AI model', sourceName: 'BBC', sourceDomain: 'bbc.example.com' }),
    qualityArticle(3, { canonicalUrl: 'https://techcrunch.example.com/aurora', title: 'OpenAI unveils Aurora artificial intelligence model', sourceName: 'TechCrunch', sourceDomain: 'techcrunch.example.com' }),
    qualityArticle(4, { canonicalUrl: 'https://reuters.example.com/openai?fbclid=123', title: 'OpenAI Aurora model announcement' }),
    qualityArticle(5, { canonicalUrl: 'https://second.example.com/openai', title: 'OPENAI ANNOUNCES AURORA AI MODEL!' }),
    qualityArticle(6, { title: 'Google launches Gemini AI model' }),
    qualityArticle(7, { title: 'OpenAI delays Aurora AI model' }),
    qualityArticle(8, { title: 'Flood evacuation orders issued across coastal towns' }),
    qualityArticle(9, { title: 'Satellite detects unusual ocean temperatures', publishedAt: '2026-09-14T10:00:00Z' }),
    qualityArticle(10, { title: 'Undated company announcement', publishedAt: null, dateKind: 'unknown' }),
    qualityArticle(11, { title: 'Invalid dated story', publishedAt: '2026-02-30T08:00:00Z' }),
    qualityArticle(12, { title: 'Future announcement', publishedAt: '2026-09-18T08:00:00Z' }),
    qualityArticle(13, { title: 'Brave page modification hint', dateKind: 'page_age' }),
    qualityArticle(14, { title: 'OpenAI launches Aurora AI model', canonicalUrl: 'https://older.example.com/aurora',
      publishedAt: '2026-09-16T10:00:00Z', fetchedAt: '2026-09-16T10:10:00Z', lastSeenAt: '2026-09-16T10:10:00Z' }),
  ];
}
