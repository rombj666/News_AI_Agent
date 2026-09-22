export interface QualityArticle {
  id: string;
  canonicalUrl: string;
  title: string;
  sourceName: string;
  sourceDomain: string;
  description: string;
  publishedAt: string | null;
  fetchedAt: string;
  lastSeenAt: string;
  dateKind: 'published' | 'page_age' | 'unknown';
  contentKind: 'snippet' | 'feed_excerpt' | 'full_text';
  aliases: string[];
}
export type Freshness = 'fresh' | 'stale' | 'undated' | 'uncertain_date' | 'future' | 'invalid_date';
export type MatchKind = 'seed' | 'canonical_url' | 'normalized_title' | 'near_title';
export interface ClusterMember { article: QualityArticle; matchKind: MatchKind; similarity: number; freshness: Freshness }
export interface StoryCluster {
  id: string;
  title: string;
  topicLabel: string;
  representative: QualityArticle;
  members: ClusterMember[];
  firstSeenAt: string;
  latestSeenAt: string;
  sourceCount: number;
  articleCount: number;
}
export interface StoryCandidate {
  clusterId: string;
  title: string;
  representative: QualityArticle;
  sources: { articleId: string; source: string; url: string; links: string[]; publishedAt: string | null; freshness: Freshness }[];
  sourceCount: number;
  articleCount: number;
}
export interface QualityStatistics {
  rawArticles: number; freshArticles: number; exactDuplicates: number; nearDuplicates: number;
  staleArticles: number; undatedArticles: number; uncertainDateArticles: number; futureArticles: number;
  invalidArticles: number; storyClusters: number; finalCandidates: number;
}
