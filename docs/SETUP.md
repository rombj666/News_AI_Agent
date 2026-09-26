# Setup and boundaries

Current local scheduling setup: [SCHEDULING.md](SCHEDULING.md). Preview/confirm
settings with `schedule:settings`, then explicitly opt into a one-run test or
`scheduler:dev`. The latter runs polling and scheduling in one PGlite process.
No Neon branch, Cloudflare deployment or webhook is required for this phase.
Live scripts load `.env`; normal tests/demos do not. Older foundation notes below
are historical; the scheduling guide describes current live requirements.

1. Run npm ci, npm run check, npm test, npm run demo with Node 22.12+.
2. No accounts or credentials are required for the foundation. PGlite runs the migration against an isolated local PostgreSQL engine, with no installed database server.
3. For explicit retrieval live testing, create an ignored .env from .env.example and follow docs/NEWS_PIPELINE.md. Only that command reads it. Store secrets there rather than in chat. Cloudflare will use secret bindings.
4. Before live operation, configure OpenAI API access, Brave Search, a Telegram bot and allowlisted Telegram user ID, and a Neon development branch. No resources have been created yet.
5. Use a dedicated non-owner runtime role with grants to only required tables. Apply migrations with a separate owner. The local role harness in scripts/local-db.ts shows RLS behavior for tests; it is not production provisioning.

Development defaults: 15-minute proposal expiry, 30-day active-history window, 12,000 input tokens, 2,000 output tokens, 10 fresh searches/day, USD 10/month planning ceiling. These are provisional values, not confirmed personal settings. The retrieval live test uses its own explicit rate/budget and enforced ten-request/day account collection cap. General LLM/product-wide limits are not yet wired. Schedule stays disabled until onboarding confirms it.

Health endpoint: GET /health only. It reports component stage, not database/provider readiness. All other routes return 404. No scheduled handler is installed yet.
