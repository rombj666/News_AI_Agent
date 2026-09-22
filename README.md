# Personalized AI News Agent

Local project folder: `C:\Users\rombj\Downloads\News_AI_Agent`. All ongoing development takes place here.

A Telegram-first personal news assistant using RSS + Brave, OpenAI GPT-5.6 Luna, and Neon PostgreSQL, with Cloudflare deployment planned after local validation.

## Current state

Milestones 0–3: the foundation plus RSS/Atom and Brave News retrieval, normalized PostgreSQL article storage, duplicate detection, collection run tracking, metered Brave requests, and deterministic freshness filtering/story clustering. This is not a running Telegram bot. No digest generation or LLM calls are implemented; the existing Luna-only boundary remains unchanged.

No API keys are needed for local tests/demo. A fetch guard prevents them from calling live providers, even if keys exist in the shell. PGlite runs PostgreSQL locally; Neon remains the production database choice. Worker still exposes health only, with no collection, digest, or Telegram endpoint/schedule.

## Local commands

Requires Node.js 22.12+ and npm. From this folder:

```sh
npm ci
npm run check
npm test
npm run demo
npm run demo:quality
```

The demo uses an isolated in-memory database, creates two sample users, previews and confirms a preference, retrieves archived conversation text, and records synthetic usage. It does not use real news or billable services. Tests and demo discard their databases when finished.

Copy `.env.example` to `.env` only when configuring real integration work. Never paste credentials into chat or commit them. Only the separate live-test entrypoint loads `.env`. See [retrieval setup and live-test requirements](docs/NEWS_PIPELINE.md).

## Explicit retrieval live test

```sh
npm run test:live:retrieval
```

This command is separate from `test` and `demo`. It refuses to run without explicit opt-in, an enabled RSS source, a Brave key/query, and configured pricing/budget. When configured, it performs at most one RSS fetch and one Brave request, and persists articles/runs/usage in `.local/retrieval-live-db`. Brave can incur a charge. It never calls a model, sends Telegram messages, or applies migrations to a remote database. The live path has not been exercised against real providers yet.

## Documents

- [Source specification](NEWS_AI_PROJECT_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md), [database](docs/DATABASE.md), [news pipeline](docs/NEWS_PIPELINE.md), [article quality](docs/QUALITY_PIPELINE.md)
- [Context and memory](docs/AI_CONTEXT_MEMORY.md), [Telegram flow](docs/TELEGRAM_FLOW.md)
- [Cost tracking](docs/COST_TRACKING.md), [roadmap](docs/ROADMAP.md), [setup](docs/SETUP.md)
- [Verified model and technical decisions](docs/DECISIONS.md)

The next milestone is preference-driven classification/ranking and digest composition under the Luna-only boundary. It is not part of the completed retrieval and quality milestones. Neon connection wiring, production scheduling, and Telegram delivery remain later work.

