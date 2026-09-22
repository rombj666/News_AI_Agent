# News AI Agent implementation

Canonical project directory: `C:\Users\rombj\Downloads\News_AI_Agent`. The user requested all subsequent edits and commands here on 17 September 2026. Do not recreate the application in the old ChatGPT project mirror.

Read NEWS_AI_PROJECT_SPEC.md and docs/ROADMAP.md before work. The user authorized implementation on 17 September 2026; the original spec's documentation-only status describes the preceding task.

- TypeScript core; Node local development, Cloudflare Workers/Cron production, Neon PostgreSQL authority.
- Generative model: OpenAI gpt-5.6-luna only. Never silently substitute another model. RSS first, Brave for fresh/broader retrieval; no OpenAI web search.
- Implement by milestones. Report the actual tested state, not planned features as completed.
- Permanent settings require explicit confirmation, an ownership check, expiry, and optimistic version validation. Memory and feedback cannot bypass this.
- Keep private data user-scoped. Composite ownership keys and RLS are defense in depth; never run production requests as a table-owning/superuser database role.
- Context must be bounded and relevant. Archive old chats; do not delete them during consolidation.
- Record every billable attempt, distinguish unknown usage from zero, and use integer money units. No real provider calls in default tests.
- Keep channel adapters, business services, retrieval, AI, database access, and accounting separate. Prefer simple typed functions over frameworks or autonomous agents.
- Validate configuration and external inputs. Do not log keys, connection strings, raw private messages, or provider response bodies on errors.
- Run npm run check, npm test, and npm run demo for foundation changes. Add focused tests for real invariants and failure paths.
- Use versioned SQL migrations; do not edit an already deployed migration. Keep docs current and record significant decisions.
- Do not edit synced references or the parent project's AGENTS.md. Never commit .env, .dev.vars, credentials, local databases, or generated output.

- Milestone 3 is deterministic article quality/clustering, superseding the original milestone label. Keep quality independent of LLM calls and private queries. Run npm run demo:quality when changing this pipeline; see docs/QUALITY_PIPELINE.md.
