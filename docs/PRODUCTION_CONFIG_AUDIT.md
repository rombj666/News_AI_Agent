# Production configuration audit — 2026-09-29

## Verified scope and enablement gate

Local code/configuration audit only. No deployment, provider generation, remote SQL,
secret writes, preference changes, webhook changes or transport changes were made.
Cloudflare secret-name inspection could not authenticate on this machine. Deployed
secret presence, their values, live Neon health and the live model failure therefore
remain unverified. The production settings in the request are user-reported.

Validation on temporary Node 22.23.0: `npm run check`, all 183 offline tests,
`npm run demo:telegram`, `npm run demo`, and `git diff --check` passed. The config
preflight passed with synthetic complete bindings and rejected missing local
OpenAI key/ranking/digest budgets. These fixture amounts are not production defaults.
No real provider calls were made. The new tests exercise the actual production
tick with injected offline dependencies; scheduler/database integration tests use
PGlite, not concurrent live Neon connections.

Changed files: `src/production/runtime.ts` (shared validation/test injection),
`scripts/production-config-check.ts` and `package.json` (offline preflight),
`tests/production-telegram.test.ts`, `tests/scheduler.test.ts`,
`tests/telegram.test.ts` (regressions), this audit and `docs/ROADMAP.md`.
No SQL migration or deployed configuration was changed.

`wrangler.jsonc` currently has `PRODUCTION_SCHEDULE_ENABLED=NO`. `productionTick`
drains the interactive inbox, then returns before collection/ranking/digest. This
explains the disabled automatic generation despite the every-minute cron.

**The switch remains NO until approved ranking/digest budgets and required bindings
are validated.** No budget amounts were supplied and none were invented. The next
configuration change is `PRODUCTION_SCHEDULE_ENABLED=YES` after the preflight below.
Do not deploy the candidate until this gate is satisfied.

## Bindings

| Binding | Storage | Audit |
| --- | --- | --- |
| `PRODUCTION_SCHEDULE_ENABLED` | var | NO; change to YES only after validation |
| `TELEGRAM_AI_ENABLED` | var | YES |
| `OPENAI_MODEL` | var | `gpt-5.6-luna`, locked; no fallback |
| `MAX_INPUT_TOKENS`, `MAX_OUTPUT_TOKENS` | vars | 12000 / 2000 |
| `RSS_SOURCES_JSON` | var | One enabled BBC Technology feed |
| `SCHEDULE_NOTIFY_EMPTY` | var | NO |
| `SCHEDULE_BRAVE_QUERY` | var | Empty; Brave disabled |
| `OPENAI_RANKING_MONTHLY_BUDGET_NANODOLLARS` | var or secret | Not in checked-in vars; deployed binding unknown |
| `OPENAI_DIGEST_MONTHLY_BUDGET_NANODOLLARS` | var or secret | Not in checked-in vars; deployed binding unknown |
| `OPENAI_TELEGRAM_MONTHLY_BUDGET_NANODOLLARS` | var or secret | Not in checked-in vars; deployed binding unknown |
| `OPENAI_API_KEY` | secret | Deployed presence/value unverified |
| `DATABASE_URL` | secret | Existing `news_runtime` Neon URL required |
| `COLLECTOR_DATABASE_URL` | secret | Existing `news_collector` Neon URL required |
| `QUALITY_DATABASE_URL` | secret | Existing `news_quality` Neon URL required |
| `TELEGRAM_BOT_TOKEN` | secret | Existing working token; do not replace |
| `TELEGRAM_WEBHOOK_SECRET` | secret | Existing webhook secret; do not replace |
| `PRODUCTION_HEALTH_SECRET` | secret | Existing `/ready` bearer secret |
| `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_USER_MAP` | secrets recommended | Private IDs/mapping; existing values must match active Neon users |

Budgets are ordinary non-sensitive integer configuration; the code also accepts
them as secrets if that is how production stores them. USD 1 = 1,000,000,000
nanodollars. Each budget must be positive and at most 9,000,000,000,000. Do not
define conflicting values as both vars and secrets. With 12000/2000 token limits,
each attempt reserves 5,400,000 nanodollars before provider work. A positive budget
below that remaining allowance passes shape validation but cannot fund an attempt.
This is a reservation calculation, not a recommended monthly budget or live price
verification. Ranking/digest allowances are per user/job type; Telegram shares a
per-user conversation allowance across preference interpretation and explanations.

`SCHEDULER_INTERVAL_SECONDS` defaults to 30 for the local runner; it does not change
the Cloudflare cron. The runtime supplies the internal live gates; production does
not require `RUN_LIVE_SCHEDULED_PIPELINE` or `RUN_LIVE_RETRIEVAL` bindings.

## Timing, saved news and coverage

Keep `* * * * *`. `occurrence()` reads confirmed `deliveryEnabled`, `deliveryTime`
and `timezone`. Disabled or before-time users return `not_due`, without a claim,
retrieval, AI or delivery. For 07:00 Asia/Kuala_Lumpur, the occurrence is 23:00 UTC
on the previous UTC date. A late tick catches up on the same local date; enabling
after 07:00 can start that day's run immediately.

`UNIQUE(user_id,local_date,digest_type)` plus `INSERT ... ON CONFLICT DO NOTHING`
claims one attempt per local date/type. With the unchanged Normal preference this
prevents duplicate 07:00 runs. A changed digest type is a different key; this is
not a universal one-run-per-date constraint. Unique user/digest and scheduled
delivery-part keys add protection. Failed, empty, running and uncertain claims
are not automatically retried. Never delete claims to force a live retry or resend
an uncertain Telegram delivery. Existing transport/idempotency logic is unchanged.

`/news` reads the latest succeeded saved digest ordered by generation time. It
does not generate. Before any digest it says `Your news briefing is not ready yet.`
After generation it returns the saved briefing. No redesign was made.

BBC Technology alone is technically sufficient to run the RSS pipeline, but does
not guarantee eligible stories or a digest. It provides poor Malaysia/USA coverage
and is biased toward BBC technology. User `Sources: Not set` means no user source
preference; it does not disable the global RSS feed. No sources were added.

Later Brave enablement requires a deliberate `SCHEDULE_BRAVE_QUERY` (at most 400
characters and 50 words), `BRAVE_API_KEY` secret, and vars
`BRAVE_COST_PER_REQUEST_NANODOLLARS`, `BRAVE_PRICING_VERSION`,
`RETRIEVAL_MONTHLY_BUDGET_NANODOLLARS`. Cost must fit the budget; the configured
adapter uses 10 daily requests. Verify approved pricing/allowances before enabling.
Readiness now checks this optional configuration using the same validator as execution.

## Readiness and diagnostics

`/ready` already checked scheduling limits when the switch was YES. It now shares
complete schedule/optional-Brave validation with execution before database work.
It validates Telegram syntax/AI configuration, mapping and RSS config, then checks
active mapped runtime users/preferences/inbox, collector batches and quality runs.
The Neon adapter verifies actual database roles are non-owner, non-superuser and
cannot bypass RLS. A failure yields HTTP 503; wrong/missing health bearer yields 403.
Readiness does not spend money to verify model access, Telegram token validity or
provider availability, and its small read probes do not prove every write privilege.

Retained safe logs: `PRODUCTION_SCHEDULE_RESULT: not_due|completed|no_fresh|failed`
(also `already_attempted` and `uncertain`). Failed claimed runs persist
`failure_stage` and `failure_code`. Setup failures before a claim log
`PRODUCTION_TICK_FAILED`; readiness failures log `PRODUCTION_READINESS_FAILED`.

Preference route: message → deterministic `classifyMessage()` →
`interpretPreference()` → metered reservation/job → `OpenAIResponses` → validated
proposal → explicit confirm/cancel. No production exception was inferred from the
generic reply. `TELEGRAM_APPLICATION_REQUEST_FAILED: <SAFE_ERROR_CODE>` is already
retained and covered by new tests. No model/provider/DB response body or private
text is printed. Unknown errors remain `INTERNAL_OR_DATABASE_ERROR`.

`MODEL_TIMEOUT`, `MODEL_NETWORK_OR_RESPONSE_ERROR`, `OPENAI_HTTP_*` identify model
transport/provider failures; `PREFERENCE_BUDGET_EXCEEDED` rejects before a billable
attempt. `PREFERENCE_OUTPUT_INVALID` identifies explicit semantic output checks;
JSON/schema or untyped provider failures can be `MODEL_OUTPUT_OR_PROVIDER_ERROR`.
Unknown usage retains its reservation, not zero. Failed calls with known usage
retain actual estimated cost. An unknown entry with zero reservation blocks new
work in its budget scope. `job_runs` records failure codes; a failed settlement
leaves the original running job/unknown reservation to avoid rebilling. Reconcile
against provider records, never clear these entries merely to bypass the budget.

## Exact operator sequence (not executed here)

Use Node >=22.12 in this checkout. On the deployment machine authenticate Wrangler,
then inspect names only:

```sh
npx wrangler secret list --name personalized-news-ai-agent
```

Compare the names with the table and inspect non-secret vars in Cloudflare. Names
alone cannot prove secret values are valid. If the OpenAI key is absent:

```sh
npx wrangler secret put OPENAI_API_KEY --name personalized-news-ai-agent
```

If storing the approved missing budgets as secrets, the exact commands are:

```sh
npx wrangler secret put OPENAI_RANKING_MONTHLY_BUDGET_NANODOLLARS --name personalized-news-ai-agent
npx wrangler secret put OPENAI_DIGEST_MONTHLY_BUDGET_NANODOLLARS --name personalized-news-ai-agent
npx wrangler secret put OPENAI_TELEGRAM_MONTHLY_BUDGET_NANODOLLARS --name personalized-news-ai-agent
```

Enter approved values at the prompt; do not put values in command history or send
them to chat. Alternatively set budgets as checked-in normal vars. Keep existing
Neon/Telegram/identity bindings. Their missing-secret command, if audit shows one
is absent, is `npx wrangler secret put BINDING_NAME --name personalized-news-ai-agent`,
using the exact binding from the table and its existing approved value. No missing
remote binding has been established by this audit.

**`wrangler secret put` deploys a Worker version immediately.** These are future
deployment-window instructions, not no-deploy validation commands. See
[Cloudflare secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/).

Make approved secrets/budgets available locally through ignored `.dev.vars` (dotenv
format) or environment on the operator machine, using the intended production
values. The new preflight overlays the actual checked-in vars and validates a
candidate YES configuration without network or file changes:

```sh
npm run production:check-config
```

It must report `PRODUCTION_SCHEDULE_CONFIG_VALID`. Failure reports only field names
or a fixed code. It does not download/decrypt deployed secrets or prove live access.
The current Wrangler file is strict JSON; retain that format for this preflight.

After approval/validation, edit only `PRODUCTION_SCHEDULE_ENABLED` to `YES` in
`wrangler.jsonc`, retain the cron and other settings, then run:

```sh
npm run check
npm test
npm run demo:telegram
npm run production:check-config
npx wrangler deploy --name personalized-news-ai-agent
npx wrangler tail personalized-news-ai-agent --format pretty
```

In a second terminal, with `WORKER_URL` set to the existing HTTPS Worker origin
and `PRODUCTION_HEALTH_SECRET` securely loaded, run:

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${PRODUCTION_HEALTH_SECRET}" "${WORKER_URL}/ready"
```

Expect HTTP 200 with `{"status":"ready"}`. Do not use verbose curl or shell tracing.
Check `/preferences` still shows en, Normal, Simple, delivery enabled, 07:00,
Asia/Kuala_Lumpur, AI 5, Malaysia/USA, sources not set, entertainment excluded.
Observe `not_due` before 07:00; at/after the next due occurrence expect `completed`
and a Telegram briefing, then `already_attempted` on later ticks. `no_fresh` means
no usable briefing and no notification with the current flag; it is not a successful
digest acceptance. Inspect failure metadata if `failed`/`uncertain` occurs.

Using an authorized runtime Neon SQL session, substitute only your existing app
user UUID (not Telegram ID); this read-only diagnostic selects metadata, not bodies:

```sql
BEGIN;
SELECT set_config('app.user_id', '<existing-app-user-uuid>', true);
SELECT local_date, digest_type, scheduled_for, status, ranking_status,
       delivery_status, failure_stage, failure_code, digest_id
FROM scheduled_pipeline_runs WHERE user_id=request_user_id()
ORDER BY started_at DESC LIMIT 5;
SELECT status, error_code, created_at
FROM job_runs WHERE user_id=request_user_id()
  AND job_type='preference_interpretation' ORDER BY created_at DESC LIMIT 5;
SELECT status, error_code, estimated_cost_nanodollars, reserved_cost_nanodollars,
       input_tokens, output_tokens, created_at
FROM ai_usage WHERE user_id=request_user_id()
  AND job_type IN ('preference_interpretation','news_explanation')
ORDER BY created_at DESC LIMIT 10;
ROLLBACK;
```

After a completed run, send `/news` and verify it returns the same latest saved
briefing. The command is an intentional user request and can send it again; the
at-most-once protection above concerns automatic scheduled delivery.

To diagnose natural language, keep tail running and send exactly `Give me more AI
news` once. With AI already at 5, a successful interpretation may say already set;
otherwise cancel any proposal to preserve settings. Do not confirm a change. On
failure capture only the application error code and UTC timestamp, and correlate
with the scoped metadata above. Do not repeatedly resend: distinct updates can
incur distinct calls. If no failure occurs, the earlier error remains undiagnosed.
