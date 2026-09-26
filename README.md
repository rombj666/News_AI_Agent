# Personalized AI News Agent

Canonical project: `C:\Users\rombj\Downloads\News_AI_Agent`.

TypeScript personal news assistant: shared RSS/Brave collection, deterministic
freshness/clustering, OpenAI `gpt-5.6-luna` ranking and saved digests, Telegram
commands, feedback and confirmed preferences. Milestone 6 is user-reported live
verified. Milestone 7 adds local daily scheduling. Production deployment remains
 deferred. `/news` displays saved digests without billable generation.

## Offline validation

Requires Node 22.12+ and npm:

```sh
npm ci
npm run check
npm test
npm run demo
npm run demo:quality
npm run demo:telegram
npm run demo:scheduler
```

Tests/demos use isolated PGlite databases, mocked providers and a network guard.
They do not read `.env` or incur provider charges.

## Local daily schedule

See [scheduling setup and architecture](docs/SCHEDULING.md). Stop `telegram:dev`
before setup or scheduler commands. The persistent PGlite directory supports
one process; `scheduler:dev` runs polling and scheduling together.

Preview settings, then explicitly confirm the returned proposal within 15 minutes:

```sh
npm run schedule:settings -- propose --enabled true --time 07:00 --timezone Asia/Kuala_Lumpur --type normal
npm run schedule:settings -- confirm PROPOSAL_UUID
```

Live commands load `.env` and require `RUN_LIVE_SCHEDULED_PIPELINE=YES`, Telegram
configuration, `OPENAI_API_KEY` and explicit ranking/digest monthly budgets.
Enabled RSS feeds are collected. Brave is optional and requires its own limits.

```sh
npm run scheduled-run:telegram-user
# Equivalent one-run live test:
npm run test:live:scheduled-pipeline
# Continuous scheduler plus Telegram polling:
npm run scheduler:dev
```

Manual scheduled runs reuse the existing linked user, retrieve shared news,
rank fresh candidates, save a digest and deliver it. A persisted daily claim
prevents repeated AI calls and sends. No fresh candidates means no AI digest.
For the earlier stored-articles-only workflow use `npm run digest:telegram-user`;
see [manual digest](docs/TELEGRAM_MANUAL_DIGEST.md).

No Cloudflare Cron, Worker deployment, production Neon connection or Telegram
webhook is added. Worker remains health-only. Keep the local computer/process running.

## Documents

For delivery failures, stop the bot and run `npm run telegram:diagnose`; see
[Telegram diagnostics and retest steps](docs/TELEGRAM_DIAGNOSTICS.md).

Telegram UX: `/start` shows your saved setup; `/preferences` shows full settings.
Ask “Send my news at 8:30 AM”, “Stop automatic delivery” or “Use UK time” to preview
a change, then Confirm/Cancel. New digests use short summaries and source-provided
images when available. Explain defaults to 40–80 words; request more detail explicitly.
See [Telegram UX and image behavior](docs/TELEGRAM_UX.md).

- [Specification](NEWS_AI_PROJECT_SPEC.md), [roadmap](docs/ROADMAP.md)
- [Architecture](docs/ARCHITECTURE.md), [database](docs/DATABASE.md), [setup](docs/SETUP.md)
- [Scheduling](docs/SCHEDULING.md), [cost tracking](docs/COST_TRACKING.md)
- [News](docs/NEWS_PIPELINE.md), [quality](docs/QUALITY_PIPELINE.md), [digests](docs/DIGEST_GENERATION.md)
- [Telegram](docs/TELEGRAM_FLOW.md), [decisions](docs/DECISIONS.md)
