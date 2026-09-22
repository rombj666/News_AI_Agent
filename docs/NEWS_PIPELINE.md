# News retrieval — Milestone 2

Implemented: configurable RSS 2.0/Atom feeds, Brave News Search, normalization, filtering, PostgreSQL article persistence, URL/title deduplication, run/provenance tracking, and external-cost accounting. No LLM calls, digest generation, or Telegram delivery.

## Flow and boundaries

`NewsRetriever` in `src/domain/ports.ts` is the common provider interface. `RssRetriever` and `BraveRetriever` return bounded candidate batches; `collectNews` owns run identity, reservations, normalization, filters, persistence, and settlement through the existing `Database` interface.

RSS is the first source. Brave is an explicit collection request, not an automatic fallback after every feed failure. A future orchestration/ranking milestone will decide coverage gaps; none of this triggers a model. Do not invoke the raw Brave adapter outside the metered collection service in live application code.

1. Validate request/config; require a configured per-request Brave rate and collection allowance before searching.
2. Start a durable run (UUID). For Brave, atomically reserve cost and write an unknown attempt to `ai_usage` before the network call.
3. Fetch once, with a default 15-second timeout, 2 MB decoded-body limit, and redirects disabled. No automatic retries or pagination. RSS considers at most 100 items; Brave at most 50.
4. Parse each provider's response, retaining valid siblings when one item is malformed. Convert to `NewsCandidate` then `NormalizedArticle`.
5. Filter blocked domains, stale timestamps, and dates over five minutes into the future. Missing/invalid/relative dates remain NULL, explicitly unknown, and are stored without claiming freshness.
6. Persist articles, aliases, per-run provenance, counts, and cost settlement in one transaction. Record sanitized failure codes rather than credential-bearing exception bodies.

`number_fetched` means the bounded batch considered, including invalid items, not every entry beyond the configured limit in a large feed. Inserted, duplicate, filtered and failure counts explain the outcome. A provider-level failure can have zero fetched and one failure. `partial` means a parsed batch had item failures; `failed` means the provider batch failed. Start/end timestamps and estimated external cost live on the run.

## Source configuration

Edit `config/rss-sources.json`: stable `id`, display `name`, HTTPS feed `url`, `category`, `enabled`. BBC World/Technology entries are starter examples and disabled until intentionally selected. Configuration rejects duplicate IDs/URLs and obvious private/literal-IP/credential URLs. Feed URLs are trusted operator configuration, never arbitrary chat-submitted URLs; DNS/egress restrictions are still needed before public URL submission.

RSS supports ETag/Last-Modified validators and records a 304 as a successful zero-item run. Validators are tied to an opaque hash of the selection so a changed time window, user scope, limit, or blocklist re-reads the feed. A changed feed URL clears validators. DTD/entity declarations are rejected; XML parsing is byte-bounded. Only UTF-8 feeds are supported. Redirecting feeds must use their final HTTPS URL. RSS 1.0/RDF is not supported.

## Normalization and deduplication

- Common shape: canonical/original URL, source name/domain, title, normalized title/hash, plain-text description/snippet, published/fetched timestamps, content kind, date kind, and bounded raw metadata.
- URL identity removes fragments and common tracking parameters and sorts remaining parameters. Preserve HTTP/HTTPS distinction, path case, trailing slash, and content-bearing query values to avoid merging distinct resources.
- Title identity is SHA-256 of publisher hostname (without `www.`), UTC publication day, and Unicode-normalized lowercase title with punctuation/spacing normalized. Unknown dates use fetch day. This catches same-publisher duplicates without merging separate publishers or recurring daily headlines. Different date hints may prevent title matching; canonical URL/aliases still deduplicate.
- Unique constraints protect canonical URLs, title hashes, and aliases. A short transaction-level advisory lock serializes duplicate resolution; no network operation runs inside it. This intentionally simple global article-write lock can be narrowed after measured scale warrants it.
- Duplicate alternate URLs are saved in `article_urls`; later title edits on those URLs cannot create a duplicate. Milestone 3 preserves the first-seen title and known publication date while accepting longer descriptions and explicit dates that replace unknown/page_age hints. Each retained encounter has provenance; last_seen_at advances without making old articles fresh. See [article quality](QUALITY_PIPELINE.md).
- `articles` stores shared content. Provider, query/category, source config, and window live on `retrieval_runs`; raw item metadata, original URL/source, and each encounter's timestamp live on `article_retrievals`. Private query text never goes in shared articles.
- Brave `page_age` can be publication OR modification time: store `date_kind=page_age`, never verified publication. Atom `updated` and Brave human-readable `age` are metadata, not invented publication dates.

## Cost, replay and recovery

Brave rate comes from the operator's actual plan; no free-credit assumption or hard-coded public price. Accounting uses integer USD nanodollars. Reservations enforce a dedicated account-wide collection monthly budget and daily request cap, including private/shared runs in this database. This is not yet a combined product-wide LLM/search budget or per-plan SaaS quota.

One run = at most one provider request. Repeating the same run ID/request returns its existing record without re-fetching. Changed input under that ID is rejected. Runs still `running` are not implicitly restarted. Successful Brave batches settle the configured estimate in the existing ledger; failed/uncertain calls keep NULL cost and retain the full reservation. Even HTTP failures are conservatively held until billing is reconciled. RSS external request fee is zero; hosting/bandwidth are outside this estimate.

On a database error during settlement, articles/provenance/settlement roll back together. The earlier running run and unknown Brave ledger remain. Inspect/reconcile such runs before issuing a new run ID; a crash does not prove the provider did not charge. No automatic recovery sweep or provider-invoice reconciliation command exists yet.

## Offline tests and explicit live command

`npm test` injects fixture HTTP responses and blocks real `fetch`; `npm run demo` is also offline. Tests cover parsing, malformed/oversize responses, timeouts, filtering, URL/title/alias duplicates, validators, budget/replay, rollback, and private provenance isolation. No keys required.

The only live-test command is:

```sh
npm run test:live:retrieval
```

Enable the chosen feed in `config/rss-sources.json`, then set these environment fields (or put them in ignored `.env`):

| Field | Required value |
|---|---|
| `RUN_LIVE_RETRIEVAL` | Exactly `YES` |
| `LIVE_RSS_SOURCE_ID` | ID of an enabled configured source |
| `BRAVE_API_KEY` | Your Brave subscription token |
| `LIVE_BRAVE_QUERY` | Explicit query, at most 400 characters / 50 words |
| `BRAVE_COST_PER_REQUEST_NANODOLLARS` | Positive gross request estimate from your plan; 1 USD = 1,000,000,000 nanodollars |
| `BRAVE_PRICING_VERSION` | Rate/plan reference and verification date |
| `RETRIEVAL_MONTHLY_BUDGET_NANODOLLARS` | Positive budget at least one request estimate |

The command makes at most one RSS request (10-item limit) and one Brave request (3-result limit), within a ten-request/day collection cap. Data persists in local PGlite at `.local/retrieval-live-db`, ignored by Git. Re-running preserves articles, migrations, reservations, and usage. It does not use `APP_MODE=live` or require OpenAI/Telegram/Neon credentials. Retrieval-only config is validated before opening the database or network. Never run this as part of normal tests, demos, CI, or install hooks.

No remote Neon migrations are applied. Neon will use the same migration/Database boundary with a separately provisioned least-privilege collector role; that connection/deployment stage remains later work.

## Provider references

Brave News contract verified 2026-09-17: [API reference](https://api-dashboard.search.brave.com/api-reference/news/news_search/get), [getting started](https://api-dashboard.search.brave.com/app/documentation/news-search/get-started). XML parser: [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser). Feed availability, account access, and billing have not been validated by offline tests.

