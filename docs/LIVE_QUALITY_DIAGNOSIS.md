# Live candidate diagnosis

Inspected `.local/retrieval-live-db` offline at 2026-09-23 13:50:43 UTC.
No OpenAI, Brave, or RSS requests were made. The database was read directly,
and its articles evaluated through the same `prepareStories` pipeline used by
`refreshQuality`. No article URLs, titles, private queries, or raw responses are included here.

| Measurement | Count |
|---|---:|
| Stored articles | 15 |
| Valid publication timestamps (all explicit `published`) | 11 |
| Missing publication timestamps (`unknown`) | 4 |
| Published within 24 hours | 0 |
| Published within 48 hours | 0 |
| Published within 168 hours | 5 |
| Exact / near duplicates in the stored quality pool | 0 / 0 |
| Articles admitted to clustering after date validation | 11 |
| Historical clusters after duplicate grouping | 11 |
| Eligible candidates with default 24-hour freshness | 0 |

All 15 stored articles survive duplicate matching, but the four undated articles
are excluded before clustering. Each of the 11 admitted articles forms its own
cluster. Every cluster is excluded from candidates because its sole member is stale.
There are no invalid, future, or uncertain non-null dates in this pool.

Per-record reasons below use ordinal positions ordered by `fetched_at,id`, as in
the service, rather than exposing article identities. Times are UTC.

| Record | Published at | Exclusion |
|---|---|---|
| 1 | 2026-09-15 23:27:17 | Stale |
| 2 | 2026-09-16 10:02:05 | Stale |
| 3 | 2026-09-14 16:09:56 | Stale |
| 4 | 2026-09-13 18:49:37 | Stale |
| 5 | 2026-09-16 23:18:47 | Stale |
| 6 | 2026-09-16 23:41:57 | Stale |
| 7 | 2026-09-17 08:22:12 | Stale |
| 8 | 2026-09-14 23:07:56 | Stale |
| 9 | 2026-09-14 17:05:31 | Stale |
| 10 | 2026-09-17 09:18:57 | Stale |
| 11–13 | Missing | Undated; excluded before clustering |
| 14 | 2026-09-17 12:58:18 | Stale |
| 15 | Missing | Undated; excluded before clustering |

Retrieval used a seven-day lookback; successful retrieval does not guarantee
eligibility under the stricter quality default. All records were fetched on
September 17 (12:51–13:03 UTC), with last observations that same day.
`published_at` determines freshness, never `fetched_at` or `last_seen_at`.
Re-fetching an old article preserves its explicit publication date.
The service converts database timestamps to ISO UTC correctly. The 48-hour story
span controls title matching, not candidate freshness. `allowPageAge` remains false.
There is no demonstrated quality or OpenAI integration bug to fix.

## Populate fresh candidates without billable search

Run the existing RSS-only collector in PowerShell. These explicit process values
override `.env` defaults and prevent Brave from running:

```powershell
$env:RUN_LIVE_RETRIEVAL = 'YES'
$env:LIVE_RETRIEVAL_PROVIDER = 'rss'
$env:LIVE_RSS_SOURCE_ID = 'bbc-technology'
npm run test:live:retrieval
```

This stores current feed results in the same local database and makes no OpenAI
request. Fresh candidates require feed items with explicit publication timestamps
within the preceding 24 hours. An unchanged or stale feed cannot guarantee them;
do not alter timestamps, substitute fetch times, enable uncertain dates, or expand
production freshness merely to pass the live test. The OpenAI live script now
prints safe counts and exclusion reasons if candidates are still empty, before
any model request. Running that OpenAI command with eligible candidates remains
a separate, billable opt-in action.

## Validation

`npm run check` passed. `npm test` ran 67 tests: 66 passed, including both new
diagnostic tests; one existing RSS configuration test failed because it expects
every feed to be disabled while BBC Technology is enabled in the checked-in
configuration. Neither that configuration nor the unrelated test was changed.
Production quality rules and the OpenAI integration remain unchanged.
