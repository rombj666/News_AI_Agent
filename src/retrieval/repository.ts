import type { Queryable } from '../db/database.js';
import type { NormalizedArticle } from './normalize.js';
import type { RssSource } from './sources.js';

export async function syncSource(tx: Queryable, source: RssSource) {
  const result = await tx.query<{ etag: string | null; last_modified: string | null; cache_key: string | null }>(
    `INSERT INTO sources(id, name, feed_url, category, enabled) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, enabled = EXCLUDED.enabled,
       etag = CASE WHEN sources.feed_url = EXCLUDED.feed_url THEN sources.etag ELSE NULL END,
       last_modified = CASE WHEN sources.feed_url = EXCLUDED.feed_url THEN sources.last_modified ELSE NULL END,
       feed_url = EXCLUDED.feed_url
     RETURNING etag, last_modified, cache_key`, [source.id, source.name, source.url, source.category, source.enabled],
  );
  return result.rows[0]!;
}

export async function persistArticle(tx: Queryable, article: NormalizedArticle): Promise<{ id: string; duplicate: boolean }> {
  // Short transaction-level lock serializes duplicate resolution, including alias
  // URLs whose titles changed. Network calls never occur inside this lock.
  await tx.query('SELECT pg_advisory_xact_lock(74102919)');
  const existing = await tx.query<{ id: string }>(
    `SELECT a.id FROM articles a LEFT JOIN article_urls u ON u.article_id = a.id
     WHERE a.canonical_url = $1 OR u.canonical_url = $1 OR a.title_hash = $2
     ORDER BY CASE WHEN a.canonical_url = $1 OR u.canonical_url = $1 THEN 0 ELSE 1 END, a.id LIMIT 1`,
    [article.canonicalUrl, article.titleHash],
  );
  let id = existing.rows[0]?.id;
  const duplicate = id !== undefined;
  if (!id) {
    const result = await tx.query<{ id: string }>(
      `INSERT INTO articles(canonical_url, title, normalized_title, title_hash, source_name, source_domain,
        description, published_at, fetched_at, date_kind, content_kind, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$9) RETURNING id`,
      [article.canonicalUrl, article.title, article.normalizedTitle, article.titleHash, article.source, article.sourceDomain,
        article.description, article.publishedAt, article.fetchedAt, article.dateKind, article.contentKind],
    );
    id = result.rows[0]!.id;
  } else {
    // Re-fetching an old article cannot make it fresh: only a known publication
    // date can replace an unknown/page-age hint. Never move a known date forward.
    await tx.query(`UPDATE articles SET last_seen_at=GREATEST(last_seen_at,$2::timestamptz),
      description=CASE WHEN length($3)>length(description) THEN $3 ELSE description END,
      published_at=CASE WHEN $4::timestamptz IS NOT NULL AND $5='published'
        AND date_kind<>'published' THEN $4::timestamptz ELSE published_at END,
      date_kind=CASE WHEN $4::timestamptz IS NOT NULL AND $5='published'
        AND date_kind<>'published' THEN 'published' ELSE date_kind END
      WHERE id=$1`, [id,article.fetchedAt,article.description,article.publishedAt,article.dateKind]);
  }
  await tx.query('INSERT INTO article_urls(canonical_url, article_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [article.canonicalUrl, id]);
  return { id, duplicate };
}
