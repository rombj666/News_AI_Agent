# Database

The full target schema is specification section 6. Migration 0001 implements foundation tables and remains unchanged. Migration 0002 adds retrieval; digests/delivery/memory tables remain later work.

## Migration 0002 — retrieval

| Table | Role |
|---|---|
| `sources` | RSS configuration, validators, opaque selection cache key, last successful fetch |
| `articles` | Shared canonical URL, source name/domain, title/hash, snippet, publication/fetch times, content/date kind |
| `article_urls` | Unique aliases linked to articles after title deduplication |
| `retrieval_runs` | Provider, optional user/source, query/category/window, replay key, status/timestamps, outcome counts, failures, reserved/estimated cost and rate version |
| `article_retrievals` | Run/article association, item index, original URL/source, fetch time, duplicate flag and bounded raw metadata |

Query/category are stored through the run relation instead of leaking private queries into shared articles. Provenance ownership is inherited from the required run_id foreign key; RLS checks the owning run. Normal user runtime can only read shared articles/sources and its own runs/provenance. The trusted news_collector role writes retrieval tables and only Brave news_collection ledger rows; it cannot read chats/preferences. Provision that exact role separately for Neon; the local helper provisions NOLOGIN test roles only. No public collection endpoint exists.

Collector reservation and ledger write-ahead insertion are one transaction; final article/provenance/run/ledger settlement is another. Locks cover reservation and article identity resolution, with no network calls inside transactions. Unique URL/title/alias constraints add duplicate protection.

## Foundation invariants

- UUID internal identity; Telegram identity stored separately and uniquely as a decimal string.
- Preferences are a validated compact JSON document plus version in this first milestone. Domain-specific preference tables remain a later normalization step before retrieval; no separate source of truth is created in memory.
- Composite (user_id, id) keys enforce conversation/message ownership. Every private query is scoped explicitly and additionally protected by RLS.
- All private tables enable and force RLS using transaction-local app.user_id. Tests execute requests under a non-owner role. Migration tooling/bootstrap remains privileged and is not exposed to public HTTP.
- Confirmation locks the proposal and profile, checks pending status/expiry/version, updates preferences and version, and marks the proposal confirmed in one transaction. Cancellation is owner-scoped. Expired proposals cannot be applied even if their stored status has not yet been swept.
- Money is integer USD nanodollars (1 USD = 1,000,000,000), transported as bigint/string. NULL means unknown cost/usage, not free.
- UTC timestamptz fields; user timezone stored as an IANA identifier. No destructive archive expiry in this migration.
- Message search uses PostgreSQL full-text search with explicit user/time scope. Original text and timestamps are returned for citations; no embeddings model is configured.

Migrations run transactionally with a version/checksum ledger. Reapplying an unchanged migration is a no-op; a changed applied migration is rejected. Local tests use real PostgreSQL semantics via PGlite. Neon-specific connection behavior and live deployment remain untested until a Neon branch is configured.

## Migration 0003 — article quality

Adds articles.last_seen_at (backfilled from fetched_at), quality_runs (evaluation time, algorithm/config/statistics), story_clusters (representative, title/topic, observation times, source/article counts, active state and run) and article_cluster_members (unique article membership, match reason and similarity). Existing migrations are unchanged. No raw articles or private provenance are deleted.

A refresh atomically replaces derived memberships, deactivates old clusters and upserts current clusters under quality/article-write locks. Local news_quality can read articles/aliases and write quality state but cannot read chats or private retrieval runs. Runtime can read clusters/members. Equivalent Neon roles remain deployment work. See [quality pipeline](QUALITY_PIPELINE.md) for snapshot semantics and limits.
