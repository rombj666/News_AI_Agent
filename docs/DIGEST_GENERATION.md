# Milestone 5: personalized daily digest generation

The user's September 23 milestone assignment supersedes the original numbering:
Milestone 4 is Luna classification/ranking; Milestone 5 is digest generation.
Telegram remains unstarted. The user reports successful live Luna ranking
verification; this work does not repeat that paid check.

## Service and data flow

`generateDigest(database, model, request, limits, options?, now?)` returns a
channel-independent structured digest and whether it replayed a saved result.
The request identifies the user, unique operation ID, existing ranking operation
IDs, period, optional quick/normal/deep type, and explicit `force` regeneration.
Ranking IDs replace caller-provided article bodies: ownership and successful
`news_ranking` state are validated, and source evidence comes from the database.

The service reads the active user's validated preference document and version.
No profile changes, memory inference, conversation reads, retrieval, quality
refresh, or new ranking calls occur. Classified cluster IDs join active stored
clusters. Only explicit publication dates inside both the unchanged 24-hour
freshness window and requested half-open period are admitted. Undated, uncertain,
future and stale sources are excluded. Periods span at most 24 hours; callers
supply UTC instants for their desired day/timezone.

At most 10 ranking jobs (up to 200 classified stories), 20 stored members per
cluster, and 4 prompt sources per selected story are read/used by default.
Repeated cluster IDs use the newest supplied ranking. Classification is reused;
its original preferences can be older, so current priorities and exclusions apply
again deterministically. Existing ranking records do not retain an immutable
article snapshot; current stored evidence for the same active cluster is used.
Inactive clusters need separately refreshed/ranked inputs.

Selection uses relevance/importance weighting (60/40), plus topic, region and
source priority weights (6/4/2 per priority point). Zero excludes a match.
Exclusions match normalized whole phrases in categories, topics, entities,
regions, domains and headlines. This is conservative lexical matching, not
semantic synonym detection. Temporary interests are not yet implemented.

| Type | Default maximum stories | Summary characters | Explanation characters |
|---|---:|---:|---:|
| QUICK | 5 | 220 | 160 |
| NORMAL | 12 | 500 | 300 |
| DEEP | 20 | 900 | 600 |

Lengths, weights, top-story count, snippet length, source count and total story cap
live in `src/digest/config.ts`. NORMAL follows the existing onboarding default.
Fewer eligible stories produce a shorter digest. The top two appear only in Top
Stories; remaining stories group by a preferred region or primary category,
including AI & Technology. Empty sections never appear.

Only language/style and selected story data go into the prompt: selection already
applied other preferences. Snippets default to 700 characters and headlines to 500.
Lowest-priority stories are removed to fit a conservative UTF-8 input bound.
The digest output ceiling defaults to 6,000 tokens; the live smoke test uses 2,500
and at most three stories. Limits are configurable. If one story cannot fit,
generation fails before billing. Zero eligible stories return
`NO_ELIGIBLE_RANKED_STORIES`, with no model call, digest row or usage attempt.

## Model output and attribution

The existing `OpenAIResponses` adapter is reused unchanged: exact `gpt-5.6-luna`,
no tools/web search, no stored Responses history. Strict output validation follows
the [official Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs).
It requires exactly the selected IDs, summaries, why-it-matters and supporting
article IDs/quotes. Quotes must occur verbatim in supplied evidence. Unknown IDs,
additional fields and explicit generated web links are rejected. Refusal,
incomplete, timeout and malformed responses are metered failures with no retries.

Headlines, categories, regions, scores, entities, topics, source names and links
are attached by code from stored articles/classifications. The model never creates
attribution fields. Selected links are retained alongside evidence IDs; multiple
sources do not imply independent corroboration. Why-it-matters is separate
generated analysis. Summaries must remain cautious when snippets are insufficient.
Schema/quote checks cannot establish semantic truth or guarantee every claim is
entailed; broader factual evaluation remains a limitation.

`renderDigest` produces plain text with links. Future channel renderers must escape
their own markup. Generated prose follows the requested language; the initial
title, section labels and renderer labels are English.

## Persistence, idempotency and accounting

Additive migration `0005_digests.sql` adds `digests`, `digest_items`, and a composite
owner/job key. Digests retain period/type, revision, preference version, model,
counts, status and structured document. Items retain positions, cluster IDs,
generated text and source/classification metadata. Both tables use forced RLS;
composite foreign keys prevent foreign-user job/digest references. The local
non-owner runtime gets the required grants. Production provisioning is deferred.

`src/ai/metered.ts` extracts existing ranking reservation, budget, timeout and
settlement logic; ranking and digest both use it. Provider implementation remains
single. The monthly guard sums the user's existing usage and reservations,
including ranking and digest attempts. Calls use `job_type=news_digest`, existing
versioned pricing, token/cache usage, integer nanodollar estimates and elapsed time.
Unknown usage/cost stays null with a conservative reservation.

The common advisory lock covers reservation and period checks. A partial unique
index allows only one running digest per user/period/type. Completed periods replay
without model calls. Explicit `force:true` with a new operation ID creates a new
retained revision. Failed attempts also require force; running/uncertain attempts
cannot be forced past. Successful settlement atomically saves usage, job result,
digest and items. Settlement failure leaves the write-ahead reservation/running
state intact and blocks retries, including force. Such attempts require manual
reconciliation against provider billing; no automatic billable retry exists.

## Commands

Offline demo (synthetic fixtures, in-memory DB, fetch guard, $0 actual cost):

```powershell
npm run demo:digest
```

For a separately authorized live test, configure the existing `OPENAI_API_KEY`
and `LIVE_OPENAI_USER_ID` locally, and choose
`OPENAI_DIGEST_MONTHLY_BUDGET_NANODOLLARS` explicitly (1 USD = 1,000,000,000 units).
This budget includes that user's existing monthly usage. Then run:

```powershell
$env:RUN_LIVE_DIGEST = 'YES'
$env:LIVE_DIGEST_FORCE = 'NO'
npm run test:live:digest
```

This uses `.local/retrieval-live-db`, the latest ten completed ranking jobs for
that user, at most three fresh stories, and at most one Luna call. The stable
period is the current UTC calendar day, so repeated invocations replay the saved
NORMAL digest. A saved NORMAL digest from another caller for that period is also
replayed regardless of count. Missing fresh rankings must be populated separately;
this command triggers no retrieval or ranking. It reports ID/model/counts/sections,
digest text, tokens/cost, elapsed time and replay status. No credentials,
environment values, prompts or raw provider responses are printed.
The live command was added but not executed.

For deliberate billable regeneration only, use `LIVE_DIGEST_FORCE=YES` for that
invocation, then restore `NO`. No Telegram, scheduling, frontend, deployment or
Milestone 6 work is included.

## Verification and changed files

Verified locally on September 23, 2026:

- `npm run check`: passed.
- `npm test`: 86 passed, 0 failed (19 new digest tests).
- `npm run demo:digest`: passed; four synthetic stories persisted and rendered,
  with $0 actual provider cost. Ledger telemetry is explicitly synthetic.
- `npm run demo` and `npm run demo:quality`: passed.
- `git diff --check`: passed.

Tests cover length/section selection, preference weighting/exclusions, bounded
input, zero/stale stories, malformed/foreign/duplicate output, invented links and
evidence, multiple-source attribution, errors/timeouts, known and unknown usage,
monthly/token budgets, repeat/force/concurrent calls, RLS/ownership and reservation/
settlement rollback. Default tests and demos retain the offline fetch guard.
Live digest correctness and concurrency across separate Neon connections remain
unverified. No live database migration, provider generation, retrieval or
deployment was performed for this milestone.

Added:

- `migrations/0005_digests.sql`
- `src/ai/metered.ts`
- `src/digest/config.ts`, `types.ts`, `selection.ts`, `ranked-stories.ts`,
  `schema.ts`, `service.ts`, `render.ts`, `live-config.ts`
- `scripts/digest-demo.ts`, `scripts/digest-live.ts`
- `tests/digest.test.ts`, `tests/fixtures/digest.ts`
- `docs/DIGEST_GENERATION.md`

Changed:

- `src/ai/ranking.ts`: shared metering; ranking output/request-key format retained.
- `src/quality/freshness.ts`: accepts the two fields it reads via a `Pick` type;
  freshness behavior is unchanged.
- `scripts/local-db.ts`: non-owner digest table grants.
- `package.json`, `.env.example`: offline/live commands and opt-in configuration.
- `docs/ROADMAP.md`, `docs/DATABASE.md`, `docs/DECISIONS.md`, `README.md`: milestone,
  storage and command documentation.

Earlier uncommitted zero-candidate diagnostic and RSS-test-isolation changes
remain intact and are separate from this milestone.
