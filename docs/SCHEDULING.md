# Milestone 7: local scheduled pipeline

Production deployment is deferred. `src/scheduling/pipeline.ts` orchestrates
existing `collectNews`, `refreshQuality`, `rankStories`, `generateDigest`, the
Telegram renderer and `TelegramApi`. Node scripts configure providers and resolve
existing allowed identities. Only trusted local identity lookup uses owner access;
private pipeline work uses the non-owner runtime role with user-scoped RLS.

## Delivery settings

Settings can also be proposed in Telegram: “Send my news at 8:30 AM”, “Stop
automatic delivery”, “Use UK time”, or “Make my digest quick”. Conversational AI
must be enabled. The existing Confirm/Cancel workflow remains mandatory; these
requests do not create another settings store. See [Telegram UX](TELEGRAM_UX.md).

Confirmed `user_preferences.document` remains authoritative for deliveryEnabled,
deliveryTime, timezone and digestLength. Migration 0007 provides a security-invoker
`delivery_settings` view, not a second mutable copy. Nothing is enabled automatically.
Settings use existing ownership checks, 15-minute proposal expiry, Confirm/Cancel,
and optimistic profile versions.

Stop the bot first, then:

```powershell
npm run schedule:settings -- show
npm run schedule:settings -- propose --enabled true --time 07:00 --timezone Asia/Kuala_Lumpur --type normal
# Review the printed values and substitute the returned proposal ID:
npm run schedule:settings -- confirm PROPOSAL_UUID
# Or cancel:
npm run schedule:settings -- cancel PROPOSAL_UUID
```

Use the same flow for later edits, including `--enabled false`. Digest type edits
change the existing confirmed digest-length preference. Multiple allowed users
require `LIVE_TELEGRAM_USER_ID` for manual commands. No user is created. Settings
commands validate bot configuration but perform no network calls.

## Live configuration and commands

Set in ignored `.env`:

```dotenv
RUN_LIVE_SCHEDULED_PIPELINE=YES
OPENAI_RANKING_MONTHLY_BUDGET_NANODOLLARS=<your ranking budget>
OPENAI_DIGEST_MONTHLY_BUDGET_NANODOLLARS=<your digest budget>
SCHEDULER_INTERVAL_SECONDS=30
SCHEDULE_NOTIFY_EMPTY=NO
SCHEDULE_BRAVE_QUERY=
```

Also requires the existing bot token, allowlist and OpenAI key. Use positive integer
nanodollars for budgets (1 USD = 1,000,000,000 nanodollars). The model remains
`gpt-5.6-luna`. Existing input/output ceilings apply. Ranking takes at most 12
candidates, reduced before billing if needed to fit input limits; digest counts
are targets and may be smaller with limited evidence or output limits.

RSS collects enabled feeds in `config/rss-sources.json` (maximum five). Blank
`SCHEDULE_BRAVE_QUERY` disables Brave. A configured query must be shared/public,
never private per-user context. Brave then runs once alongside RSS per shared
batch, requiring the existing Brave key, price/version and retrieval budget.

```powershell
# Immediate complete pipeline; at most one occurrence:
npm run scheduled-run:telegram-user
# Exact alias of the same gated entrypoint:
npm run test:live:scheduled-pipeline
# Continuous scheduler plus Telegram polling in one process:
npm run scheduler:dev
```

All require the explicit live opt-in. The manual run ignores the due time/enabled
flag without changing settings and consumes today's local scheduling key. A
successful manual test therefore prevents a second scheduled send for that same
day/type. It prints safe stage/usage summaries. Verify the delivered digest in
Telegram, then `/news` returns the saved digest. Conversational AI enablement is
independent of scheduled AI.

The scheduler checks every 30 seconds by default (configurable 10–300 seconds).
Keep the computer awake/process running. Ctrl+C aborts polling and sleeps;
already-started AI settles within its bounded timeout before shutdown. Do not
start `telegram:dev` alongside it: PGlite needs one process, so polling is integrated.

## Timezones and shared retrieval

Local date/time is computed in each user's IANA timezone. Spring-forward gaps
run at the first valid local minute after the requested time. Fall-back repeated
times run at the first occurrence. Same-day delayed execution catches up once;
older missed calendar days are not backfilled. There is no hard-coded global hour.

Shared collection is keyed by UTC hour plus public source-configuration hash.
Users due in that hour reuse the persisted batch; retrieval is not repeated per
user. Different hours can collect again for freshness. Quality may be recomputed
without provider calls; local users execute serially. Existing freshness rules
and article timestamps are unchanged.

Provider retrieval failures are recorded. Fresh cached articles can still support
a digest. Zero fresh candidates skips AI and normally sends nothing; optional
`SCHEDULE_NOTIFY_EMPTY=YES` sends a safe no-briefing notice. Preference exclusions
may also leave no eligible digest after ranking; no fake briefing is sent.

## Persistence, budgets and recovery

Migration 0007 adds `delivery_settings`, `scheduled_collection_batches`, and
`scheduled_pipeline_runs`, and extends existing `telegram_deliveries` with a
scheduled run origin. Runs record scheduled/start/end times, user/date/type,
retrieval results, candidate count, ranking operation/status, digest ID, delivery
status and safe failure stage/code. Private tables use composite ownership keys
and RLS. Existing conversation history and story context are reused.

Unique `(user_id, local_date, digest_type)` claims commit before provider calls.
A unique owner/digest index prevents assigning the same saved digest to another
scheduled delivery. Same-day/type saved digests are reused without AI regeneration.
Each delivery part is persisted as `sending` before calling Telegram, then `sent`
with its message ID, `failed` on definite rejection, or `uncertain` on ambiguity.

Attempted occurrences never automatically rerun, including failed/interrupted
ones. There are no provider/send retries inside this pipeline. Telegram timeout
retries cannot be made safely without a provider idempotency key. Partial sends
are preserved; duplicate prevention does not promise exactly-once delivery.
An interrupted run may remain `running` and needs operator review. Do not delete
claims or retry AI blindly. A generated digest remains available via an explicit
`/news` request. Automated resume/reconciliation is deferred.

Ranking and digest each enforce their respective user/month job-type budgets,
including earlier manual jobs of that type. Telegram explanations/preference
interpretation share a separate conversation budget. Retrieval retains its
account-wide Brave limits. Existing write-ahead reservations and unknown usage
remain fail-closed; all attempts use the normal `ai_usage` ledger. Older commands
retain their conservative all-usage caps where configured.

Persistent DB entrypoints acquire a directory-wide `.process-lock`, in addition
to the bot lock. After an unclean crash, first verify all project Node processes
have stopped; only then manually remove stale lock files in `.local`. Never
remove a live process's lock. PostgreSQL constraints protect daily claims, but
Neon multi-connection behavior remains a later deployment verification gate.

No Cloudflare Cron, Worker deployment, production Neon, or webhook is configured.
Offline tests/demos use isolated local databases and mocked providers.

## Verification

TypeScript check, all 144 offline tests, scheduler demo, foundation demo and
Telegram demo passed. Tests include due/disabled/timezone/DST behavior, shared
collection, full pipeline, saved digest reuse, persisted restart/process locking,
interrupted claims, no fresh candidates, failures at provider stages, partial
Telegram sends, and separate budget enforcement. Live scheduled verification is
still a manual step; no actual retrieval, AI or Telegram send was run here.
