# Decisions and verified references

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
