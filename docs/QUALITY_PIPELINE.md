# Article quality — Milestone 3

Implemented locally, with deterministic rules only. No OpenAI calls, digest generation, delivery, scheduling or frontend. GPT-5.6 Luna remains the only future model boundary.

## Entry points

`prepareStories(articles, now, options)` is the pure quality pipeline. `refreshQuality(database, now, options)` reads the existing shared article pool and persists its derived clusters atomically. Both return fresh representative candidates with all retained cluster source links. The caller supplies evaluation time; refresh before using candidates rather than treating an old snapshot as permanently fresh.

`npm run demo:quality` uses fictional fixtures and an isolated PostgreSQL database with network access blocked. It prints raw/exact/near/stale counts, cluster counts and final candidates, then demonstrates ingestion and persisted clustering. Ingestion already removes some exact duplicates, so stored-pool counts differ from raw-fixture counts. Duplicate and stale counts overlap; they are not an additive partition.

## Identity and matching

- Canonicalization removes fragments and common tracking parameters, sorts remaining query parameters, normalizes unreserved percent encoding and host spelling. Original URLs remain in retrieval provenance and aliases. HTTP/HTTPS, www/apex, path case, trailing slash and content query parameters remain distinct unless another identity rule matches them; no redirects are fetched.
- Existing ingestion URL/alias and publisher/day title-hash constraints remain. Quality additionally groups canonical aliases, normalized exact titles across publishers, and similar titles without deleting original articles or provenance.
- Similarity uses normalized Unicode title tokens, a small English synonym map and Jaccard overlap. Guards reject conflicting numbers, negation, opposing actions and incompatible named tokens. All distinct cluster identities must match, limiting chains of loosely related headlines. Canonical duplicates represent one resource and do not impose contradictory title constraints.
- Except for canonical URL identity, matches must fit the configured publication-time span. Recurring identical headlines on distant dates remain separate.
- Choose a fresh representative first, then prefer explicit publication dates, configured source priority, richer content, longer descriptions and newer publication dates, with stable tie-breaking. Keep every eligible member's links, including stale members explicitly marked stale. Source count means distinct publisher hostnames, not independently verified reporting.

## Configuration and freshness

Pass options to either entry point; defaults are validated by `src/quality/config.ts`.

| Option | Default | Meaning |
|---|---|---|
| windowHours | 24 | Freshness window, 1–168 hours; 48 and 168 support two days and one week |
| allowPageAge | false | Explicit opt-in to uncertain provider modification/publication dates |
| maxStorySpanHours | 48 | Maximum publication span for title-based clustering |
| titleThreshold | 0.65 | Minimum Jaccard similarity, configurable 0.5–1 |
| minimumSharedTokens | 3 | Minimum shared tokens for near-title matching |
| maxArticles | 2000 | Refuse oversized pools rather than silently truncate; hard maximum 5000 |
| sourcePriority | {} | Explicit hostname priorities, 0–100; no default publisher preference |

Use publication time, never fetch time, for freshness. The lower window boundary is inclusive. Missing dates, invalid calendar dates, future timestamps and uncertain dates are excluded from candidates and clustering; stale articles can remain historical cluster members. Re-fetching an old article updates last_seen_at but does not move its known publication time forward. A newly supplied explicit publication date may replace unknown/page_age metadata.

## Persistence and operational limits

Additive migration 0003 adds articles.last_seen_at, quality_runs, story_clusters and article_cluster_members; migrations 0001/0002 remain unchanged. Runs record evaluation time, algorithm version, validated configuration and statistics. Clusters store representative, title/topic label, first/latest observation, source/article counts and active state. Members store matching reason and similarity.

A transaction takes quality and article-write locks, reads a bounded stable pool, then replaces derived memberships and upserts current clusters. Historical cluster rows become inactive; old membership snapshots are not retained. Failures roll back the refresh. Cluster IDs derive from the earliest-seen member, so later arrivals retain identity; backfills, configuration or algorithm changes may regroup stories and change IDs. No private query or chat data enters clustering.

The local news_quality role reads public articles/aliases and writes quality tables; it cannot read private retrieval queries or chats. Provision equivalent privileges separately for Neon. No remote migration or deployment was performed.

Headline heuristics are conservative and English-oriented, not semantic understanding or factual verification. They may split paraphrases or merge ambiguous headlines. Complete-link comparisons are quadratic in the bounded pool; larger archives need a separately designed batching/indexing strategy. Local PGlite tests do not establish multi-connection Neon concurrency behavior.

## Verification

`npm run check`, `npm test`, `npm run demo:quality` and `npm run demo` pass. The suite has 52 tests, including tracking variants, exact/near cross-source matches, misleading shared words, contradictory titles, date boundaries, missing/invalid dates, stable cluster updates, retained links, representative selection, rollback and role isolation. No live services or models are called.
