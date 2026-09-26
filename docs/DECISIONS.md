# Decisions and verified references

## Milestone 7 local scheduling decisions

- User explicitly reassigned Milestone 7 to local scheduled pipeline and Telegram
  delivery. Cloudflare/production Neon/webhooks remain deferred.
- Reuse confirmed preferences as delivery settings via a view, avoiding competing
  copies and preserving existing ownership/expiry/version/confirmation rules.
- Collection is shared per UTC-hour/public-configuration batch. Private ranking
  and digest work remains per user. No automatic AI or send retries; interrupted
  claims require review because an external outcome may be unknown.
- Ranking/digest budgets use their respective job-type totals; Telegram AI uses
  explanation plus preference-interpretation totals. All retain the same ledger,
  unknown reservations and integer money accounting.
- Local scheduler owns PGlite and Telegram polling together. Directory-level lock
  prevents other local DB entrypoints opening it concurrently. Crash-stale locks
  require manual verification before removal.
- DST gaps run at the next valid local minute; repeated times at their first
  occurrence. Same-day catch-up only. One manual test consumes that day's key.

## 2026-09-17 — foundation

- Follow the approved spec; implement documentation and foundation first. Application files live in this subdirectory, separate from synced ChatGPT references.
- Verified official model ID: `gpt-5.6-luna`. Responses API and structured outputs are supported. Standard text prices are USD 0.20/M input, 0.02/M cached input, 1.20/M output. Inputs above 272K have different pricing, and cache writes have an additional rate; the foundation estimator is limited to ordinary text input below that threshold. Account-level access is not verified. [OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-luna).
- PostgreSQL migrations with a small typed database boundary; PGlite for offline integration tests/demo. It is a local test tool, not a change from Neon production. [PGlite getting started](https://pglite.dev/docs/).
- Node built-in test runner + tsx, TypeScript strict mode, Zod input validation. Pin direct dependencies and commit the lockfile. No ORM needed for this first small schema.
- Start with a validated compact preference document and profile version. Normalize topic/region/source data during the relevant milestone; explicitly recorded refinement of the logical schema, not duplicated state.
- Foundation Worker is health-only. Cron schedules are UTC; later scheduling must resolve each user's timezone and persisted due state. Do not assume Cron itself accepts user-local times. [Cloudflare Cron documentation](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
- No embedding provider selected, no fallback model, no live spend, no deployment, no source/feed choices implied by sample data.

## 2026-09-17 — Milestone 2

- Extend NewsRetriever/Database ports. RSS/Atom uses pinned fast-xml-parser; fetch is injected. No model dependency or call added.
- Migration 0002 leaves 0001 unchanged. Shared articles and owner-scoped run provenance; a restricted collector service role cannot read private chats/settings.
- Deduplicate canonical URLs and publisher/day-scoped title SHA-256 hashes; preserve aliases. Keep separate publishers/days distinct.
- Use Brave News Search, one request/page per run, no retries. page_age can be a modification date. [Official contract](https://api-dashboard.search.brave.com/api-reference/news/news_search/get).
- Reserve run costs and reuse ai_usage. Operator rates and dedicated collection caps are explicit; a combined product budget remains future work.
- Fetch guard keeps tests/demo offline. Exactly one env-gated live test uses persistent local PostgreSQL. No CI, Worker route, cron, or normal-demo live retrieval.
- Starter feeds disabled; feed availability, Brave account access and Neon connectivity remain unverified by the offline suite.

## 2026-09-17 — Milestone 3 scope revision

The user explicitly inserted deterministic article quality and clustering before the originally planned preferences/digest work. Use publication-based freshness, conservative title matching and additive migration 0003. Preserve article/provenance rows and source links; rebuild bounded derived cluster state transactionally. Missing/invalid/uncertain dates are excluded by default. No LLM, delivery, scheduler or frontend is added. See QUALITY_PIPELINE.md for configuration and limitations.

## 2026-09-23 — Milestone 5 personalized daily digests

The user assigned Milestone 4 to Luna ranking (reported live-verified) and
Milestone 5 to daily digest generation, superseding original numbering. Reuse
persisted ranking jobs, structured DB preferences and the existing Luna adapter.
Select stories in code; use the model only for bounded structured summaries and
analysis. Attach stored attribution in code and validate supporting evidence IDs
and quotes. Preserve strict 24-hour freshness; no retrieval inside digest jobs.

Extract common model metering from ranking instead of duplicating provider/budget
services. Add migration 0005 with RLS, composite ownership keys and retained
period/type revisions. Completed digests replay; deliberate regeneration requires
force and a new operation ID. Unknown running attempts block even force pending
billing reconciliation. Zero-story requests make no model call and save no digest.
Offline mocks cover failures and produce a $0 demo. A separate live gate permits
one small NORMAL digest; it has not been run. No Telegram/Milestone 6 work.
