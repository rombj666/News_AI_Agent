import { rankingOutputSchema } from '../ai/ranking-schema.js';
import { ModelError } from '../ai/openai.js';
import { asUser, type Database } from '../db/database.js';
import { uuidSchema } from '../domain/preferences.js';
import { freshness } from '../quality/freshness.js';
import { qualityConfigSchema } from '../quality/config.js';
import { canonicalUrl } from '../retrieval/normalize.js';
import type { DigestSource, RankedStory } from './types.js';

// Read only: no quality refresh, retrieval, or ranking call. Trust DB attribution,
// never caller-supplied candidates or model-produced links.
export async function loadRankedStories(db: Database, userId: string, operationIds: string[], now: Date,
  periodStart: Date, periodEnd: Date): Promise<RankedStory[]> {
  if (operationIds.length > 10 || new Set(operationIds).size !== operationIds.length) throw new ModelError('DIGEST_RANKING_LIMIT');
  operationIds.forEach(id => uuidSchema.parse(id));
  return asUser(db,userId,async tx => {
    const jobs = await tx.query<{ id: string; result: unknown }>(`SELECT id,result FROM job_runs WHERE user_id=$1
      AND id=ANY($2::uuid[]) AND job_type='news_ranking' AND status='succeeded' ORDER BY updated_at DESC,id`,[userId,operationIds]);
    if (jobs.rows.length !== operationIds.length) throw new ModelError('DIGEST_RANKING_NOT_OWNED_OR_READY');
    const stories: RankedStory[] = [];
    const seen = new Set<string>();
    for (const job of jobs.rows) {
      for (const classification of rankingOutputSchema.parse(job.result).stories) {
        if (seen.has(classification.clusterId)) continue;
        seen.add(classification.clusterId);
        const members = await tx.query<{ id:string; title:string; canonical_url:string; source_name:string; description:string;
          published_at:Date|null; date_kind:'published'|'page_age'|'unknown'; content_kind:string; representative:boolean;image_url:string|null }>(
          `SELECT a.id,a.title,a.canonical_url,a.source_name,a.description,a.published_at,a.date_kind,a.content_kind,a.image_url,
            a.id=c.representative_article_id AS representative FROM story_clusters c
            JOIN article_cluster_members m ON m.cluster_id=c.id JOIN articles a ON a.id=m.article_id
            WHERE c.id=$1 AND c.active=true ORDER BY representative DESC,a.published_at DESC,a.id LIMIT 20`,[classification.clusterId]);
        const sources: DigestSource[] = [];
        let headline: string | null = null;
        for (const row of members.rows) {
          const publishedAt = row.published_at?.toISOString() ?? null;
          if (freshness({publishedAt,dateKind:row.date_kind},now,qualityConfigSchema.parse({})) !== 'fresh') continue;
          if (!row.published_at || row.published_at < periodStart || row.published_at >= periodEnd) continue;
          canonicalUrl(row.canonical_url); // Validate stored links; preserve the exact stored value.
          headline ??= row.title;
          sources.push({articleId:row.id,name:row.source_name,url:row.canonical_url,publishedAt:publishedAt!,
            snippet:row.description,contentKind:row.content_kind,...(row.image_url?{imageUrl:row.image_url}:{})});
        }
        if (headline && sources.length) stories.push({rankingOperationId:job.id,classification,headline,sources});
      }
    }
    return stories;
  });
}
