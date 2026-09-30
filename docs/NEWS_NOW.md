# News now, live search and schedule UX

Implemented locally on 2026-09-30. No deployment or paid live check was run.

## Commands and routing

- `/news` retrieves fresh personalized news using Brave News Search plus configured RSS, refreshes deterministic quality/clustering, ranks with GPT-5.6 Luna, generates and saves a source-linked digest, then renders it in Telegram.
- `/latest` reads the most recent succeeded digest without retrieval or model calls.
- `/schedule` reads the committed schedule. `/schedule 08:30`, `/schedule 8:30 PM`, `/schedule on`, and `/schedule off` create normal preference proposals.
- `/start` and `/help` show the supported actions and Telegram navigation buttons.

Deterministic routing distinguishes news-now requests, current-news questions,
permanent preferences, schedule changes, temporary interests, stored-story questions,
commands, and unsupported text. Time words only indicate a temporary interest when
paired with an instruction to change focus. A one-time request never updates
preferences.

Current-news questions use the same source-linked short digest path. This preserves
provenance and lets normal story Explain buttons use the retrieved articles. Luna
does not provide current facts without retrieved candidates.

## Retrieval and privacy

Explicit news requests use Brave as the primary search. Broad `/news` queries are
constructed deterministically from positive saved topic and region priorities.
Explicit subjects override those priorities for retrieval while saved language,
style, length, exclusions and ranking context continue to apply.

Configured RSS feeds are also collected. Article persistence, canonical URL/title
deduplication and story clustering merge duplicates across RSS and Brave. BBC
Technology remains the only checked-in feed; this is technically usable but weak
for Malaysia/USA coverage. No sources were silently added.

Private query text is stored only in the requesting user's RLS-protected retrieval
run. It is not added to shared scheduled collection metadata. `news_now_runs` claims
the Telegram operation before retrieval, preventing duplicate or interrupted updates
from automatically repeating paid calls. Brave usage uses the existing reservation,
monthly budget and daily request accounting. OpenAI ranking/digest calls keep their
existing job and usage reservations.

Brave `page_age` dates are admitted only for explicit live-news quality runs. The
scheduled pipeline keeps its stricter default. Undated, future and stale candidates
remain excluded.

Fresh Telegram requests are persisted by the webhook and processed by the existing
minute cron. This avoids Cloudflare HTTP `waitUntil()`'s 30-second post-response
limit for retrieval plus two model calls. Lightweight commands remain immediate.
The same cron continues to check per-user schedule occurrences; there are no
per-user cron triggers.

## Schema

Migration `0011_news_now.sql` adds:

- `digests.purpose`: `scheduled`, `news_now`, or `current_question`. This prevents an interactive digest from satisfying/replacing an automatic daily digest.
- `news_now_runs`: user-scoped operation claims, outcome, digest reference and safe failure stage/code, protected by forced RLS.

Apply migrations with the existing owner/migration process, then apply the updated
least-privilege grants. The runtime role receives only select/insert/update on
`news_now_runs`.

## Configuration

Secrets:

- `OPENAI_API_KEY`
- `BRAVE_API_KEY`
- `DATABASE_URL`, `COLLECTOR_DATABASE_URL`, `QUALITY_DATABASE_URL`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `PRODUCTION_HEALTH_SECRET`
- Telegram IDs/mapping should also remain private.

Normal vars:

- `OPENAI_MODEL=gpt-5.6-luna`
- `MAX_INPUT_TOKENS`, `MAX_OUTPUT_TOKENS`
- `OPENAI_TELEGRAM_MONTHLY_BUDGET_NANODOLLARS`
- `OPENAI_RANKING_MONTHLY_BUDGET_NANODOLLARS`
- `OPENAI_DIGEST_MONTHLY_BUDGET_NANODOLLARS`
- `BRAVE_COST_PER_REQUEST_NANODOLLARS`
- `BRAVE_PRICING_VERSION`
- `RETRIEVAL_MONTHLY_BUDGET_NANODOLLARS`
- `RSS_SOURCES_JSON`, `SCHEDULE_NOTIFY_EMPTY`, `SCHEDULE_BRAVE_QUERY`

No budget or pricing values were invented. `npm run production:check-config` is
offline and reports missing field names only. It validates Brave even when the
scheduled Brave query is empty, because interactive `/news` always requires Brave.

The optional `npm run production:check-live` requires both:

```sh
RUN_LIVE_PRODUCTION_CHECK=YES
LIVE_PRODUCTION_QUERY="a deliberate low-volume verification query"
```

It checks runtime/collector/quality Neon roles, Telegram API connectivity, one Brave
search, one RSS fetch, Luna ranking, digest, stored-story explanation and preference
interpretation. Brave and all four OpenAI checks can incur real charges and write
usage/job/retrieval/digest records. Preference proposals created by the check are
cancelled. It never sends Telegram messages and prints only PASS or sanitized codes.
Do not run it merely to validate local code.

GPT-5.6 Luna remains the only model. The implementation uses the Responses API with
structured outputs and no model web-search tool. The official model page confirms
that `gpt-5.6-luna` supports the Responses API and structured outputs:
https://developers.openai.com/api/docs/models/gpt-5.6-luna

## Deployment and verification (not executed)

1. Review and supply approved budgets/pricing. Run `npm run production:check-config`.
2. Only after it passes, change `PRODUCTION_SCHEDULE_ENABLED` from `NO` to `YES` if automatic delivery should be enabled.
3. Run `npm run check`, `npm test`, `npm run demo:telegram`, and `npm run demo:foundation`.
4. Apply migration `0011_news_now.sql` using the owner migration path, then the updated `scripts/production-grants.sql`.
5. Add missing secrets interactively with `npx wrangler secret put NAME --name personalized-news-ai-agent`. Secret writes deploy a Worker version, so do this only in the deployment window.
6. Deploy with `npx wrangler deploy --name personalized-news-ai-agent` and tail with `npx wrangler tail personalized-news-ai-agent --format pretty`.
7. Verify authenticated `/ready`, then `/start`, `/preferences`, `/schedule`, schedule Confirm and Cancel, and immediate `/preferences` reflection.
8. Send `/news` once. It should be acknowledged by the webhook, start on the next minute cron, produce a fresh saved briefing, and not change preferences. Replaying the same Telegram update must not create another search/model job.
9. Verify `/latest` returns the saved briefing without new retrieval/usage.
10. Try `Latest Malaysia AI news` and `What's happening with NVIDIA today?`; inspect source links and safe logs. Do not repeatedly retry failures because each new update is a new paid operation.
11. Verify `Give me more AI news every day` and `Stop showing entertainment news` create proposals; cancel unless the change is intended. Verify `Focus on NVIDIA this week` is recognized but not persisted.
12. Confirm automatic delivery uses the newly committed time, disabled delivery is skipped, and repeated cron events produce `already_attempted` rather than another delivery.

Cloudflare documents that HTTP `waitUntil()` extends execution for up to 30 seconds,
while scheduled handlers can run up to 15 minutes. See:
https://developers.cloudflare.com/workers/platform/limits/

Failure UX distinguishes missing/failed Brave (`Live news search is temporarily
unavailable.`), genuine no-results (`I couldn't find enough fresh news for that
request.`), and ranking/digest failures (`I found news, but couldn't prepare the
briefing right now.`). Logs and persisted fields retain safe codes without response
bodies, keys, URLs, private messages or preferences.
