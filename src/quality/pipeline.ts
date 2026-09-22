import { canonicalUrl, parseDate } from '../retrieval/normalize.js';
import { qualityConfigSchema, type QualityConfig, type QualityOptions } from './config.js';
import { freshness } from './freshness.js';
import { titleFeatures, titleSimilarity } from './similarity.js';
import type { ClusterMember, MatchKind, QualityArticle, QualityStatistics, StoryCandidate, StoryCluster } from './types.js';

type Prepared = { article: QualityArticle; features: ReturnType<typeof titleFeatures>; links: Set<string>; freshness: 'fresh' | 'stale' };
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function representative(members: Prepared[], config: QualityConfig): QualityArticle {
  const fresh = members.filter((member) => member.freshness === 'fresh');
  const pool = fresh.length ? fresh : members;
  const contentScore = { full_text: 3, feed_excerpt: 2, snippet: 1 };
  return [...pool].sort((a, b) =>
    Number(b.article.dateKind === 'published') - Number(a.article.dateKind === 'published')
    || (config.sourcePriority[b.article.sourceDomain] ?? 0) - (config.sourcePriority[a.article.sourceDomain] ?? 0)
    || contentScore[b.article.contentKind] - contentScore[a.article.contentKind]
    || Math.min(b.article.description.length, 1000) - Math.min(a.article.description.length, 1000)
    || Date.parse(b.article.publishedAt!) - Date.parse(a.article.publishedAt!)
    || order(a.article.canonicalUrl, b.article.canonicalUrl) || order(a.article.id, b.article.id)
  )[0]!.article;
}

function compare(a: Prepared, b: Prepared, config: QualityConfig): { kind: Exclude<MatchKind,'seed'>; score: number } | null {
  if ([...a.links].some((url) => b.links.has(url))) return { kind: 'canonical_url', score: 1 };
  if (Math.abs(Date.parse(a.article.publishedAt!) - Date.parse(b.article.publishedAt!)) > config.maxStorySpanHours * 3_600_000) return null;
  if (a.features.exact === b.features.exact) return { kind: 'normalized_title', score: 1 };
  const similarity = titleSimilarity(a.features, b.features);
  if (!similarity.compatible || similarity.shared < config.minimumSharedTokens || similarity.score < config.titleThreshold) return null;
  return { kind: 'near_title', score: similarity.score };
}

export function prepareStories(articles: QualityArticle[], now: Date, options: QualityOptions = {}) {
  const config = qualityConfigSchema.parse(options);
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid evaluation time');
  if (articles.length > config.maxArticles) throw new Error('QUALITY_POOL_LIMIT_EXCEEDED');
  if (new Set(articles.map((article) => article.id)).size !== articles.length) throw new Error('Duplicate article IDs');
  const stats: QualityStatistics = { rawArticles: articles.length, freshArticles: 0, exactDuplicates: 0, nearDuplicates: 0,
    staleArticles: 0, undatedArticles: 0, uncertainDateArticles: 0, futureArticles: 0, invalidArticles: 0, storyClusters: 0, finalCandidates: 0 };
  const eligible: Prepared[] = [];
  for (const raw of articles) {
    let article: QualityArticle;
    let links: Set<string>;
    try {
      const normalized = canonicalUrl(raw.canonicalUrl);
      links = new Set([normalized, ...raw.aliases.map(canonicalUrl)]);
      if (!parseDate(raw.fetchedAt) || !parseDate(raw.lastSeenAt) || Date.parse(raw.lastSeenAt) < Date.parse(raw.fetchedAt)) throw new Error('Invalid seen date');
      article = { ...raw, canonicalUrl: normalized, sourceDomain: new URL(normalized).hostname.replace(/^www\./, '') };
    } catch { stats.invalidArticles++; continue; }
    const state = freshness(article, now, config);
    if (state === 'undated') { stats.undatedArticles++; continue; }
    if (state === 'uncertain_date') { stats.uncertainDateArticles++; continue; }
    if (state === 'future') { stats.futureArticles++; continue; }
    if (state === 'invalid_date') { stats.invalidArticles++; continue; }
    const features = titleFeatures(article.title, article.sourceName);
    if (!features.tokens.size) { stats.invalidArticles++; continue; }
    if (state === 'stale') stats.staleArticles++; else stats.freshArticles++;
    eligible.push({ article, features, links, freshness: state });
  }
  // Earliest first-seen seed is stable as newly fetched coverage arrives. Sorting
  // independently of input order makes repeat runs reproducible.
  eligible.sort((a,b) => Date.parse(a.article.fetchedAt) - Date.parse(b.article.fetchedAt) || order(a.article.id,b.article.id));
  const groups: { prepared: Prepared[]; members: ClusterMember[] }[] = [];
  for (const item of eligible) {
    let best: { group: typeof groups[number]; kind: Exclude<MatchKind,'seed'>; score: number } | null = null;
    for (const group of groups) {
      const relations = group.prepared.map((member) => compare(item, member, config));
      const sameUrl = relations.some((relation) => relation?.kind === 'canonical_url');
      const distinctRelations = relations.filter((_relation,index) => group.members[index]!.matchKind !== 'canonical_url');
      // Complete-link constraint prevents A~B~C chains merging unrelated A and C.
      if (!sameUrl && distinctRelations.some((relation) => relation === null)) continue;
      const exact = relations.find((relation) => relation?.kind !== 'near_title');
      const score = sameUrl ? 1 : Math.min(...distinctRelations.map((relation) => relation!.score));
      const kind = sameUrl ? 'canonical_url' : exact?.kind ?? 'near_title';
      if (!best || (sameUrl && best.kind !== 'canonical_url') || (best.kind !== 'canonical_url' && score > best.score)) best = { group, kind, score };
    }
    if (!best) {
      groups.push({ prepared: [item], members: [{ article: item.article, matchKind: 'seed', similarity: 1, freshness: item.freshness }] });
    } else {
      best.group.prepared.push(item);
      best.group.members.push({ article: item.article, matchKind: best.kind, similarity: best.score, freshness: item.freshness });
      if (best.kind === 'near_title') stats.nearDuplicates++; else stats.exactDuplicates++;
    }
  }
  const clusters: StoryCluster[] = groups.map((group) => {
    const rep = representative(group.prepared, config);
    const seen = group.prepared.map((entry) => entry.article);
    return {
      id: seen[0]!.id, title: rep.title, topicLabel: [...titleFeatures(rep.title,rep.sourceName).tokens].sort().join(' ').slice(0,500),
      representative: rep, members: group.members,
      firstSeenAt: new Date(Math.min(...seen.map((entry) => Date.parse(entry.fetchedAt)))).toISOString(),
      latestSeenAt: new Date(Math.max(...seen.map((entry) => Date.parse(entry.lastSeenAt)))).toISOString(),
      articleCount: seen.length, sourceCount: new Set(seen.map((entry) => entry.sourceDomain)).size,
    };
  });
  const candidates: StoryCandidate[] = clusters.filter((cluster) => cluster.members.some((member) => member.freshness === 'fresh')).map((cluster) => ({
    clusterId: cluster.id, title: cluster.title, representative: cluster.representative,
    sourceCount: cluster.sourceCount, articleCount: cluster.articleCount,
    sources: cluster.members.map(({ article, freshness: state }) => ({
      articleId: article.id, source: article.sourceName, url: article.canonicalUrl,
      links: [...new Set([article.canonicalUrl,...article.aliases])].sort(), publishedAt: article.publishedAt, freshness: state,
    })),
  })).sort((a,b) => Date.parse(b.representative.publishedAt!) - Date.parse(a.representative.publishedAt!) || order(a.clusterId,b.clusterId));
  stats.storyClusters = clusters.length;
  stats.finalCandidates = candidates.length;
  return { config, statistics: stats, clusters, candidates };
}
