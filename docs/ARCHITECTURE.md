# Architecture

Specification sections 1–3 and 9 are authoritative. Local code uses TypeScript with dependency injection; runtime-neutral services depend on typed ports. Node is the development runtime, Workers/Cron the later production runtime, and Neon PostgreSQL the persistent state authority.

```text
RSS + Brave -> normalize/filter/deduplicate -> shared public articles
  -> deterministic freshness/quality -> story clusters + candidate representatives
  -> future Luna classify/rank -> Luna digest -> saved digest
  -> DeliveryEngine -> Telegram

Telegram -> authenticate/deduplicate -> commands or intent classification
  -> preference proposal | existing article Q&A | cache/fresh search
  -> bounded Context Builder -> Luna when necessary
```

No model tools search or mutate permanent settings. Existing-news Q&A must not automatically search. Shared collection is separate from private queries, preferences, conversations, and usage. Confirmation is a backend transaction, not an LLM instruction.

PostgreSQL access uses the existing query/transaction interface, implemented locally by PGlite. A later Neon adapter must maintain single-transaction connection and local user context. Milestone 2 extends NewsRetriever and ai_usage, without creating another database/accounting system. Worker still exposes only GET /health with no schedule or webhook.

Use a least-privilege runtime role and transaction-local app.user_id for private RLS policies. Migration owner is never the request role. Collection uses a restricted news_collector service role. Public articles are shared; private query/provenance are scoped through runs. Only trusted internal code can supply a private run's user identity.

External actions require persistent run state, bounded attempts, and idempotency keys before live adapters are enabled. Model output is validated as data. Provider calls must pass through metering and allowances; failures with unknown usage remain visible.

