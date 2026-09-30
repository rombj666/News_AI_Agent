# Roadmap and current status

Implementation authorized on 2026-09-17. Work proceeds milestone by milestone from NEWS_AI_PROJECT_SPEC.md.

News-now milestone (2026-09-30): implemented fresh `/news`, saved `/latest`,
deterministic current-news/preference/schedule routing, `/schedule` proposals,
Brave-first interactive retrieval plus RSS/dedup/quality, persisted paid-work claims,
safe preflight and an explicit opt-in live integration check. See
[NEWS_NOW.md](NEWS_NOW.md). No live checks or deployment were performed.

Production audit follow-up (2026-09-29): shared readiness/execution validation now
covers optional Brave configuration; production tick and preference diagnostics
have added offline regression coverage. See [audit and deployment runbook](PRODUCTION_CONFIG_AUDIT.md).
No deployment or memory/context work performed. Schedule enablement remains gated
on validating approved ranking/digest budgets and production bindings; Cloudflare
authentication was unavailable in this workspace.

| Milestone | Status / acceptance |
|---|---|
| 0 Documentation | Architecture, data, news, memory, Telegram, costs, decisions, and setup docs written; Luna API ID verified. Account access, source list and personal settings still need setup before live work. |
| 1 Foundation | Complete for local development: typed config/ports, migration runner, user ownership/RLS, preference confirmation, usage ledger, private history, local fixtures/demo and tests. Live identity/account integration remains milestone 4/7 work. |
| 2 Retrieval | Implemented: configurable RSS/Atom + Brave News, migration 0002, shared articles/aliases, private run provenance, filters/deduplication, feed validators, reservations/ledger, fixtures and explicit env-gated live test. Verification below. |
| 3 Article quality | Complete locally: additive migration 0003, canonical URLs, deterministic duplicate/story matching, strict freshness, persisted clusters, source links and offline demo. |
| 4 Luna ranking | Implemented locally; user reports successful live verification. Structured classification/ranking, user-scoped jobs and usage accounting. |
| 5 Personalized daily digest | Implemented; user reports live verification through the Telegram-linked manual pipeline. Persisted ranked inputs, preference selection, Luna summaries and attributed digests. |
| 6 Telegram | Implemented and user-reported live verified: local polling, commands, stored-story explanations, feedback, confirmed preferences, usage and update deduplication. |
| Later context/memory and local acceptance | Not started: bounded context, archival summaries, temporary interests, full pipeline and scheduling validation. |
| 7 Local scheduled pipeline | Implemented locally; verification recorded below. Shared retrieval, timezone-aware daily claims, ranking/digest, direct Telegram delivery and opt-in one-run test. Live scheduled run remains to be verified. |
| Later personal deployment | Deferred explicitly: Neon production, Cloudflare Worker/Cron, webhook, monitoring and pilot. |

Milestone 7 follows the user's revised scope: local scheduling before production.
Provider calls retain explicit live gates. Cloudflare Cron/deployment, registration,
commercial billing and frontend remain deferred. Worker remains health-only.

## Milestone 7 local implementation

Image follow-up: live BBC feed metadata verified; duplicate NULL-image enrichment,
count-only diagnostics, explicit manual `--force` regeneration and bounded
Telegram command-menu startup recovery implemented. See [image workflow](TELEGRAM_IMAGES.md).
Deployment remains deferred.

Live Telegram diagnosis: intermittent connection reset reproduced by read-only
probes. The failed `/news` stopped on a plain-text header, not a photo. Migration
0009 preserves safe error codes; sends are serialized and render failures handled.
All 162 offline tests passed. Live retest remains required; see
[diagnostics](TELEGRAM_DIAGNOSTICS.md). No deployment started.

Pre-deployment Telegram UX polish: implemented saved-setting overview, detailed
preferences, natural-language schedule proposals, concise generation/Explain,
optional source-provided RSS images and a three-command menu. Migration 0008 adds
image URLs and last-story context. All 152 tests passed; see [UX details](TELEGRAM_UX.md).

See [SCHEDULING.md](SCHEDULING.md) for settings confirmation, commands, schema,
timezones, budgets, shared retrieval, duplicate prevention and recovery limits.
No real scheduled provider calls or Telegram sends were performed during implementation.
The user's earlier live verification covers Milestone 6, not this new scheduler.

Local validation: `npm run check`, all 144 offline tests, `npm run demo:scheduler`,
foundation demo and Telegram demo passed. The scheduler demo used a fake 07:00
Kuala Lumpur clock, one mocked retrieval, one ranking, one digest, three Telegram
messages, and a duplicate restart with no further calls. Actual provider cost $0.

## Milestone 5 verification — 2026-09-23

`npm run check`, all 86 tests (19 new digest tests), `npm run demo:digest`,
`npm run demo`, and `npm run demo:quality` passed. The digest demo saved/rendered
four fictional stories using mocks, at $0 actual provider cost. The gated live
digest command was not run. No provider generation, retrieval, deployment or
Milestone 6 work occurred. See [digest implementation and limits](DIGEST_GENERATION.md).

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

Manual Telegram digest bridge: `npm run digest:telegram-user` resolves the existing
allowlisted Telegram identity, reuses eligible owned rankings or ranks fresh stored
articles, and saves a NORMAL digest in the polling database. No retrieval or
scheduling is added. See [manual setup](TELEGRAM_MANUAL_DIGEST.md).

Use local ignored environment files / cloud secrets for OpenAI, Brave, Telegram, and Neon credentials. Confirm personal timezone/time/language/topics during onboarding; spec examples are not actual preferences. Verify account-level Luna access with a bounded live check only once configured. Embeddings remain deferred; no blocker for full-text history.

## Milestone 3 verification

Verified on 2026-09-17: `npm run check`, all 52 tests, `npm run demo:quality` and `npm run demo` passed. The quality fixture contains 14 raw articles, 3 exact duplicates, 2 near duplicates, 2 stale articles, 5 clusters and 4 fresh candidates; statistics overlap. All three migrations initialize the local database. No live provider/model calls or remote migrations ran. See [quality rules and limitations](QUALITY_PIPELINE.md). The user's revised Milestone 3 precedes the original preferences/digest phase, which remains unimplemented.
