import type { Database, Queryable } from '../db/database.js';
import { QUALITY_VERSION, qualityConfigSchema, type QualityOptions } from './config.js';
import { prepareStories } from './pipeline.js';
import type { QualityArticle } from './types.js';

type ArticleRow = {
  id: string; canonical_url: string; title: string; source_name: string; source_domain: string; description: string;
  published_at: Date | null; fetched_at: Date; last_seen_at: Date;
  date_kind: QualityArticle['dateKind']; content_kind: QualityArticle['contentKind']; aliases: string[];
};

export async function inspectQuality(db: Queryable, now: Date, options: QualityOptions = {}) {
  const config = qualityConfigSchema.parse(options);
    const result = await db.query<ArticleRow>(`SELECT a.*,
      COALESCE((SELECT jsonb_agg(u.canonical_url ORDER BY u.canonical_url) FROM article_urls u WHERE u.article_id=a.id),'[]'::jsonb) AS aliases
      FROM articles a ORDER BY a.fetched_at,a.id LIMIT $1`, [config.maxArticles + 1]);
    const pool: QualityArticle[] = result.rows.map((row) => ({
      id: row.id, canonicalUrl: row.canonical_url, title: row.title, sourceName: row.source_name,
      sourceDomain: row.source_domain, description: row.description, publishedAt: row.published_at?.toISOString() ?? null,
      fetchedAt: row.fetched_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(),
      dateKind: row.date_kind, contentKind: row.content_kind, aliases: row.aliases,
    }));
    return prepareStories(pool, now, config);
}

export async function refreshQuality(db: Database, now: Date, options: QualityOptions = {}) {
  const config = qualityConfigSchema.parse(options);
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(74102921)');
    // Same article-write lock as collection: evaluate a stable local pool.
    await tx.query('SELECT pg_advisory_xact_lock(74102919)');
    const quality = await inspectQuality(tx,now,config);
    const run = await tx.query<{ id: string }>(`INSERT INTO quality_runs(evaluated_at,algorithm_version,config,statistics)
      VALUES ($1,$2,$3::jsonb,$4::jsonb) RETURNING id`, [now.toISOString(),QUALITY_VERSION,JSON.stringify(config),JSON.stringify(quality.statistics)]);
    const runId = run.rows[0]!.id;
    // Derived snapshot is replaced atomically. Retire old cluster IDs rather than
    // deleting historical cluster rows; original articles/provenance are untouched.
    await tx.query('DELETE FROM article_cluster_members');
    await tx.query('UPDATE story_clusters SET active=false WHERE active=true');
    for (const cluster of quality.clusters) {
      await tx.query(`INSERT INTO story_clusters(id,representative_article_id,cluster_title,normalized_topic_label,
        first_seen_at,latest_seen_at,source_count,article_count,quality_run_id,active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
        ON CONFLICT(id) DO UPDATE SET representative_article_id=EXCLUDED.representative_article_id,
        cluster_title=EXCLUDED.cluster_title,normalized_topic_label=EXCLUDED.normalized_topic_label,
        first_seen_at=EXCLUDED.first_seen_at,latest_seen_at=EXCLUDED.latest_seen_at,
        source_count=EXCLUDED.source_count,article_count=EXCLUDED.article_count,quality_run_id=EXCLUDED.quality_run_id,active=true`,
      [cluster.id,cluster.representative.id,cluster.title,cluster.topicLabel,cluster.firstSeenAt,cluster.latestSeenAt,cluster.sourceCount,cluster.articleCount,runId]);
      for (const member of cluster.members) {
        await tx.query(`INSERT INTO article_cluster_members(cluster_id,article_id,match_kind,similarity) VALUES ($1,$2,$3,$4)`,
          [cluster.id,member.article.id,member.matchKind,member.similarity]);
      }
    }
    return { runId, evaluatedAt: now.toISOString(), algorithmVersion: QUALITY_VERSION, ...quality };
  });
}
