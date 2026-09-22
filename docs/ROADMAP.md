# Roadmap and current status

Implementation authorized on 2026-09-17. Work proceeds milestone by milestone from NEWS_AI_PROJECT_SPEC.md.

| Milestone | Status / acceptance |
|---|---|
| 0 Documentation | Architecture, data, news, memory, Telegram, costs, decisions, and setup docs written; Luna API ID verified. Account access, source list and personal settings still need setup before live work. |
| 1 Foundation | Complete for local development: typed config/ports, migration runner, user ownership/RLS, preference confirmation, usage ledger, private history, local fixtures/demo and tests. Live identity/account integration remains milestone 4/7 work. |
| 2 Retrieval | Implemented: configurable RSS/Atom + Brave News, migration 0002, shared articles/aliases, private run provenance, filters/deduplication, feed validators, reservations/ledger, fixtures and explicit env-gated live test. Verification below. |
| 3 Article quality | Complete locally: additive migration 0003, canonical URLs, deterministic duplicate/story matching, strict freshness, persisted clusters, source links and offline demo. |
| Next — Preferences/digest | Not started: complete topic/region/source persistence, temporary interests, Luna classification/ranking/briefing and metered calls. |
| 4 Telegram | Not started: live identity/webhook integration, commands, delivery, conversation modes, feedback. |
| 5 Context/memory | Not started: context assembly, summaries/consolidation, temporary expiry, historical Q&A. |
| 6 Local acceptance | Not started: full pipeline, schedules, multi-user and failure/allowance validation. |
| 7 Personal deployment | Not started: Neon branch, Cloudflare Worker/Cron, live secrets, monitoring and pilot. |

Retrieval adapters now exist behind an explicit live-test gate. There is still no LLM call, digest generation, Telegram delivery, cron, registration, billing or frontend. Worker remains health-only.

## Verification

Verified on 2026-09-17 with Node 22.23.2:

- `npm run check`: passed, strict TypeScript.
- `npm test`: 16 tests passed, 0 failed. Includes PostgreSQL migration rollback/checksum, non-owner RLS, cross-user access, proposal confirmation/expiry/cancellation/replay/staleness, history retrieval, ledger duplication/retries/unknown costs, and job uniqueness.
- `npm run demo`: passed. Preference unchanged before confirmation and updated after; archived match visible to its owner only; synthetic cost correctly calculated as USD 0.000440.
- No live API calls, paid usage, Telegram sends, account provisioning, or deployment performed.

Limits of this verification: PGlite is a single local PostgreSQL engine and serializes its transactions. These checks do not prove concurrency behavior across multiple Neon connections, live Telegram delivery, Worker deployment, or account-level model access. Those have explicit later acceptance gates. The Windows sandbox blocked the test runner's user-information lookup; tests/demo passed when allowed to run outside that sandbox.

## Milestone 2 verification

Verified on 2026-09-17: `npm run check` passed; `npm test` passed all 38 tests (16 foundation + 22 retrieval); `npm run demo` passed with its network guard enabled. Fixture coverage includes RSS/Atom and Brave contracts, malformed/oversize/timeout handling, date/domain filters, URL/title/alias deduplication, validators, run replay, budgets and unknown costs, private provenance RLS and settlement rollback. No model or live provider calls occurred.

No live provider test was run. Neon connection behavior and multi-connection concurrency remain unverified; migrations are tested with PGlite's PostgreSQL engine. Both migrations initialize fresh databases, and checksum protection remains active.

## Next setup dependencies

Use local ignored environment files / cloud secrets for OpenAI, Brave, Telegram, and Neon credentials. Confirm personal timezone/time/language/topics during onboarding; spec examples are not actual preferences. Verify account-level Luna access with a bounded live check only once configured. Embeddings remain deferred; no blocker for full-text history.

## Milestone 3 verification

Verified on 2026-09-17: `npm run check`, all 52 tests, `npm run demo:quality` and `npm run demo` passed. The quality fixture contains 14 raw articles, 3 exact duplicates, 2 near duplicates, 2 stale articles, 5 clusters and 4 fresh candidates; statistics overlap. All three migrations initialize the local database. No live provider/model calls or remote migrations ran. See [quality rules and limitations](QUALITY_PIPELINE.md). The user's revised Milestone 3 precedes the original preferences/digest phase, which remains unimplemented.
