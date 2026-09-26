# Personalized AI News Agent — V1 Project Specification

Status: approved implementation source of truth. The user authorized starting development on 17 September 2026 after reviewing the summary. Current implementation status is tracked in docs/ROADMAP.md. This repository copy carries implementation clarifications; the original planning artifact remains unchanged in the parent folder.
Source: [News AI Agent Plan](chatgpt-conversation://6aab8435-1618-83ec-81aa-7914ac544b1b), finalized through 17 September 2026, plus the specification request.

Later explicit decisions supersede earlier alternatives. This specification preserves the agreed product direction; schema details, operational safeguards, repository layout, and milestone boundaries below are implementation defaults where the conversation did not finalize them. Example topics, priorities, prices, and quotas from the discussion are not confirmed account settings or commercial commitments.

## Approved milestone revision — 17 September 2026

The user assigned Milestone 3 to deterministic article quality, freshness and story clustering before preferences/digest work. The implementation contract is docs/QUALITY_PIPELINE.md and status is docs/ROADMAP.md. This milestone adds no OpenAI calls, digest generation, Telegram delivery, scheduling or frontend. The original later product roadmap remains planned scope.

## 1. Purpose and scope

Milestone 7 revision: the user assigned scheduled daily pipeline and Telegram
delivery with local validation first. Production Cloudflare/Neon/webhook work is
explicitly deferred. Current implementation contract is docs/SCHEDULING.md; the
original milestone table below remains historical planning context.

Build a personal news assistant that finds relevant worldwide, regional, and topic-specific news, selects what matters to the user, and delivers an understandable briefing each morning or at a configured time. Users can discuss stories, request fresh searches, and refine structured preferences through Telegram.

Develop and test locally first, then deploy to Cloudflare with Neon PostgreSQL. Start with one personal user, but preserve user isolation and shared collection so a later paid multi-user service does not require a backend rewrite.

V1 includes:

- Scheduled and on-demand personalized digests, source links, concise summaries, and explanations of why stories matter.
- Configurable topics, regions, sources, exclusions, language, writing style, digest length, delivery time, and timezone.
- Telegram commands, buttons, natural-language questions, explicit preference confirmation, and temporary interests with expiry.
- Stored articles, digest history, conversations, structured feedback, compact memory, and targeted historical retrieval.
- Usage accounting, configurable allowances, bounded API spending, and reliable retry behavior.

Suggested personal defaults, to confirm during onboarding: English, normal digest length, 07:00 Asia/Kuala_Lumpur, a last-24-hours news window, and roughly 10–15 selected stories. Do not silently populate the illustrative AI/Malaysia/UK/sports priorities as user choices.

## 2. Locked architecture and model choice

| Layer | V1 decision |
|---|---|
| Language | TypeScript; local Node.js development with runtime-neutral core logic |
| Production backend | Cloudflare Workers |
| Scheduling | Cloudflare Cron; start with one scheduled Worker |
| Persistent state | Neon PostgreSQL, authoritative for user state and stored content |
| Retrieval | RSS first; Brave Search API for coverage gaps, broader discovery, and fresh searches |
| Generative AI | OpenAI GPT-5.6 Luna only |
| Delivery/conversation | Telegram through a channel adapter |
| Future commercial frontend | Website/PWA, React + Vite direction; Cloudflare hosting, Telegram daily interaction, email later |

Use Luna for classification, semantic grouping where needed, relevance/importance ranking, summarization, briefing composition, natural-language intent interpretation, Q&A, and memory consolidation. No Claude, dual-model verification, premium model routing, or silent fallback to another generative model in V1. Keep a small LLM service boundary without implementing unused providers.

The API identifier `gpt-5.6-luna`, Responses API support, structured outputs, and standard text pricing were verified against official OpenAI documentation on 17 September 2026; see docs/DECISIONS.md. Account-level access still needs verification once configured. Do not substitute another model if unavailable; surface that blocker. Embeddings are a separate unresolved choice (§7), not assumed to be a Luna capability.

```text
Scheduler / on-demand request
  -> RSS + Brave collectors
  -> normalize, date/source filtering, exact deduplication
  -> shared article store in Neon
  -> Luna classification / grouping / ranking
  -> user preferences + active temporary interests + bounded feedback
  -> selected stories -> Luna briefing -> persisted digest
  -> DeliveryEngine -> TelegramAdapter

Telegram -> command/button handling or intent detection
  -> existing-news Q&A | fresh search | proposed preference change
  -> Context Builder -> Luna only when needed
```

The backend owns retrieval queries, call limits, filtering, storage, and execution. Luna interprets and processes information; it does not freely browse, directly mutate settings, or control an autonomous chain of agents. News, preference, ranking, digest, conversation, search, and delivery services remain independent of Telegram.

## 3. Retrieval and briefing pipeline

1. Fetch configured RSS feeds and reuse fresh cached articles. Use Brave only when coverage or freshness requires it, or the user requests a new search.
2. Store source/provenance, canonical URL, title, publisher, publication and retrieval times, available excerpt/text, and retrieval query/run. A search snippet is not a full article; preserve content availability.
3. Use ordinary code to remove exact URL duplicates, stale results, excluded domains, malformed records, and obvious repeats before AI calls. Define conservative treatment of missing or uncertain dates; do not present them as confirmed recent news.
4. Batch bounded candidate sets for Luna classification, importance, relevance, and story grouping. Validate structured output. Cache reusable classifications and summaries; personalize ranking separately.
5. Select a diverse, deduplicated set under the user's length and topic preferences. Compare available sources for important or conflicting claims and flag uncertainty; do not claim independent verification without evidence.
6. Generate and persist a briefing with ordered sections, source-linked stories, short summaries, and “why it matters.” Claims and counts must match retrieved records; do not invent missing facts or fill a quota with weak stories.
7. Deliver from the saved digest so failures can retry without regenerating it. Record delivery outcome and provider message references.

Collect common news once and reuse it across users. Keep user-specific searches and their private provenance separate from shared public article content. Search charges and LLM token charges are separate. Do not use OpenAI's built-in web search in the V1 pipeline.

## 4. Telegram experience and conversation modes

The digest presents top stories followed by relevant category/region sections. Support Read Source, Explain/Why This Matters, More Like This, and Less Like This actions. A full briefing can be shown within Telegram; a web/Mini App link is only offered once such a destination exists. Split long messages safely and preserve stable story references.

Commands: `/news`, `/preferences`, `/topics`, `/search`, `/ask`, `/history`, `/cost`. Natural language routes to the same services. `/history` covers past briefings and targeted conversation lookup.

| Mode | Behavior and permission |
|---|---|
| A: preference change | Interpret language, propose a structured diff, require confirmation for permanent changes |
| B: existing-news Q&A | Use the referenced stored article/digest and small relevant context; no automatic fresh search for “why?” or “tell me more” |
| C: fresh information | Check cache/freshness first, then search via Brave automatically within allowance for an explicit fresh-search request |

When fresh search is only inferred or intent is ambiguous, offer Search Latest or clarify. Never let every chat message trigger search. Historical questions use the archive, not internet search. Deterministic commands and buttons bypass Luna whenever possible.

More/Less Like This stores structured feedback and can contribute bounded ranking signals; it must not silently rewrite permanent preferences. Saving or marking an article read is also a direct database action. A permanent mute/hide-source action still follows confirmation even though interpreting its button requires no LLM.

## 5. Preference confirmation and effective state

Flow: user request -> validated proposed diff -> `pending_preference_changes` -> preview with Confirm/Edit/Cancel -> backend transaction on Confirm -> immediate database update -> next search/digest uses the new state. There is no intentional waiting period after confirmation.

- Permanent topic/region/source priorities, exclusions, language, style, schedule, and digest settings require confirmation.
- Bind proposals to the authenticated user, original values/profile version, and expiry. Reject expired, replayed, foreign-user, or stale confirmations; refresh the preview when state changed.
- Store status (`pending`, `confirmed`, `cancelled`, `expired`), requested scope/duration, provenance, and confirmation time. Retain a lightweight audit trail.
- Clarify ambiguous duration or scope. “Too much Tesla today” is not authorization to exclude Tesla permanently. Excluding football must not automatically disable every sport.
- Explicit bounded requests such as “F1 this week” become temporary interests with start/expiry interpreted in the user's timezone. Acknowledge the exact interval; ambiguous intervals need clarification. Expiry removes their influence automatically without altering the base profile.
- One-off actions such as showing a digest, explaining a story, or an explicit fresh search within allowance do not require preference confirmation.
- Confirmed preferences override inferred memory and feedback. Consolidation cannot bypass this workflow by storing a contradictory preference in memory.

## 6. Logical database schema

This is a logical schema, not SQL migrations. Use stable IDs, foreign keys, timestamps, migrations, and suitable indexes. All private rows carry `user_id`; enforce ownership through database access paths and relationships, not only UI filtering. Shared public news tables are explicitly exempt from user ownership.

| Tables | Essential fields / relationships |
|---|---|
| `users` | id, Telegram user identity, status, created_at; separate internal ID from channel identity |
| `delivery_settings` | user_id, channel, destination/chat_id, local delivery time, timezone, enabled, next_due_at |
| `user_preferences` | user_id, language, digest_length, writing_style, default_region, profile_version |
| `topics`, `regions`, `sources` | stable taxonomy/source IDs; sources include publisher, domain, feed URL, enabled state |
| `topic_preferences`, `region_preferences`, `source_preferences` | user_id, corresponding entity/key, priority or policy; unique per user/entity; priorities 0–5 |
| `exclusions` | user_id, exclusion type, normalized value |
| `temporary_interests` | user_id, topic/entity/scope, priority, starts_at, expires_at, originating message |
| `pending_preference_changes` | user_id, structured old/new values, change_type, expected profile version, duration, status, created/expires/confirmed timestamps |
| `articles` | canonical URL (unique), title, source_id, published_at, fetched_at, excerpt/available text, content hash, processing state, summary, importance, cluster_id |
| `article_topics`, `news_clusters` | article-topic associations; cluster identity, representative story, date range; retain each source article |
| `retrieval_runs`, `article_retrievals` | provider/feed/query, time window, run status, result provenance, shared/private scope, user_id when private |
| `digests`, `digest_articles` | user_id, period, generated_at, preference version/snapshot, rendered/structured content, status; ordered article links and personalized scores |
| `delivery_history` | user_id, digest_id, channel, attempt, status, provider message IDs, error, sent_at, idempotency key |
| `user_feedback`, `saved_articles`, `read_articles` | user_id, article_id, action/value, timestamp; canonical name `user_feedback` covers earlier `article_feedback` terminology |
| `conversations`, `messages` | user_id, conversation_id, role, content, created_at; optional referenced digest/article and Telegram message/update IDs |
| `conversation_summaries` | user_id, conversation/topic, covered message IDs/time range, summary, consolidation version |
| `user_memory` | user_id, type/key, compact value, provenance message IDs, confidence/status, created/updated_at; only useful durable information |
| `temporary_memory` | user_id, type/key/value, starts_at, expires_at, provenance; conversational context distinct from temporary news interests |
| `message_embeddings`, `article_embeddings` | optional future/enabled semantic index: chunk/source reference, model/version, content hash, vector; private message index always user-scoped |
| `consolidation_runs` | user_id, processed-through watermark, covered range, version, status/error; supports incremental retry |
| `ai_usage` | unified usage ledger described in §8, including AI and search operations |
| `job_runs` | job type, user/scope, scheduled occurrence, status, timestamps, bounded attempts, idempotency key |

Index user/time histories, pending statuses/expiry, due schedules, article publication times, canonical URLs, and text-search fields. Enforce unique Telegram update IDs and per-user scheduled digest occurrence keys. Store timestamps in UTC and retain IANA user timezone for local schedules. Avoid redundant preference copies in memory; confirmed structured settings remain authoritative.

## 7. Context builder, memory, archive, and embeddings

Stored data is not automatically prompt data. Build an intent-specific context under a configurable token budget, retrieving only the fields and records needed. Never attach the whole database, full user profile, all history, or even all messages from the active month.

| Request | Context to load |
|---|---|
| Today's digest | applicable preferences, active interests, bounded feedback, current article candidates; no general chat history |
| Explain story 4 | correct digest/story, available source text, relevant style/region, a few relevant recent turns |
| Change AI priority | current AI setting, scope/duration, timezone when needed; no unrelated articles/history |
| Find a past discussion | user-scoped date/topic/entity search, relevant summary and original excerpts; normally top 3–5 chunks |
| Fresh search | query, freshness requirement, relevant filters, allowance and cache state |

Use explicit article/digest references and deterministic routing first; Luna interprets ambiguous natural language when needed. Deduplicate retrieved chunks, bound excerpts/output, and log context size. Historical answers should identify dates and supporting records and acknowledge no match rather than manufacture recollections.

Memory/archive strategy:

1. Preserve raw conversation messages. A configurable approximately 30-day active/consolidation window is a tidying boundary, not an automatic deletion policy.
2. Periodically consolidate only new messages since the last successful watermark; monthly is the initial default, with weekly batching configurable.
3. Code filters trivial replies, button events, and system noise from consolidation input without deleting archive records. Group useful messages by topic and process bounded batches with Luna.
4. Produce compact conversation summaries and candidate durable/temporary memories with source references. Merge duplicates, handle contradictions, and expire temporary context.
5. Inferred permanent preference changes remain pending until confirmed. Explicit confirmed settings win over older or inferred memories. Do not turn every discussed article into a lasting interest.
6. Archive older conversations and keep them searchable. Search summaries first when useful, then load original messages to substantiate specific claims. Archive-only messages are excluded from automatic prompts.
7. Real deletion is a separate explicit retention/user-deletion policy, not memory cleanup. Initial default is keep until explicitly deleted; any later retention policy must also cover summaries, memories, and indexes.

History retrieval must work in V1 using PostgreSQL keyword/full-text search with user/date/topic filters. The discussion identified embeddings and Neon/pgvector as the semantic-search direction but did not choose an embedding provider, model, dimensions, or budget. Keep an embedding adapter/index boundary; semantic retrieval can be added after that choice is resolved. Do not silently add a second model under the Luna-only requirement. Article embeddings are optional; conversation retrieval is the immediate need. If enabled, embed useful chunks once, cache by content hash/model version, record cost, and combine semantic matches with keyword/date filters under the same user isolation.

## 8. Cost tracking and usage ledger

Track costs from the first prototype, not after launch. Every billable AI/search attempt, including retries and failed attempts with usage, must produce a ledger record.

`ai_usage` fields: id, user_id (nullable for shared collection), scope, provider, model, job_type, operation/run/request IDs, attempt, input_tokens, cached_input_tokens when reported, output_tokens, search_calls, estimated_cost, currency, pricing_version/rate snapshot, execution_time_ms, status/error, created_at. Unknown usage/cost is explicitly unknown rather than zero; reconcile from provider records where possible. Prevent accidental duplicate ledger insertion while retaining genuinely billable retries.

Account separately for:

- LLM input/output charges, including intent handling, Q&A, consolidation, and optional embeddings.
- Brave search requests, cache hits, and feed retrieval (no LLM charge merely for collecting RSS).
- Shared collection costs versus user-specific personalization/search costs; do not multiply shared expense by user count. Any per-user allocation is reported separately from actual spend.
- Infrastructure and later storage/hosting charges, separately from per-call API estimates.

`/cost` should show today/month totals, AI versus search breakdown, and remaining configured allowance. Admin-level reporting later adds provider/job/user profitability views. Apply configurable search counts, token/output ceilings, timeouts, and monthly budgets; check allowance before work and bound retries. The discussion suggested a USD 10/month personal planning ceiling, not an agreed hard production quota. Set the actual limits during setup.

Do not hard-code historical price quotes or assume free tiers/credits are guaranteed. Verify rates and account entitlements at implementation, version rate configuration, and distinguish estimated gross cost, credits, and billed totals. No paid domain, dedicated server, GPU, or native app is required for the personal prototype; API testing can incur usage charges.

## 9. Multi-user and operational design

- Share public collection, deduplication, classifications, and reusable summaries; personalize profiles, ranking, digests, memory, and delivery per user.
- Identify and authorize the Telegram sender and callback owner. Initially allowlist the personal account while exercising isolation with multiple test users.
- Validate webhook authenticity and external payloads. Keep credentials in environment/secrets, never source control, prompts, or ordinary logs.
- Treat retrieved articles and old conversation text as untrusted data, never privileged instructions. Validate model output and enforce allowed actions in backend code.
- Keep scheduling timezone-aware and idempotent. Persist jobs/digests before sending; retries must not knowingly duplicate messages. Record uncertain Telegram outcomes for reconciliation rather than promising exactly-once external delivery.
- Bound fetches, model calls, concurrency, and retries; use graceful partial results for unavailable feeds/search. Persist failure states and avoid misleading success messages.
- Start without Queues/Workflows. Introduce them only if measured runtime or reliability limits require them; keep jobs resumable and services separable.
- Design for future quotas, plans, account linking, and retention without implementing paid billing or public registration now. Later commercial direction: website/PWA + Telegram, email backup, then other channels if justified.

## 10. Development milestones and acceptance gates

| Milestone | Deliverable and completion condition |
|---|---|
| 0 — documentation | In the future implementation repository, derive AGENTS.md, architecture, schema, flows, memory, and roadmap docs; resolve API model ID, secrets/setup, source list, and limit configuration before coding dependent features |
| 1 — foundation | TypeScript project, validated configuration, migrations, personal Telegram identity, service boundaries, usage ledger, deterministic fixtures; local smoke test and user isolation pass |
| 2 — retrieval | RSS + Brave adapters, provenance, cache, date filtering, deduplication, shared article persistence; repeated fixture runs do not duplicate articles |
| 3 — preferences and digest | Structured preferences and temporary interests, Luna structured classification/ranking/briefing, source-linked saved digest; no ungrounded stories and every API attempt accounted for |
| 4 — Telegram interaction | Delivery, commands/buttons, three conversation modes, confirmation workflow, history/feedback; Q&A avoids needless search and confirmed changes take effect immediately |
| 5 — context and memory | Bounded context builder, searchable archive, incremental consolidation, summaries and expiry; old conversations retrievable without bulk prompting or silent setting changes |
| 6 — local end-to-end validation | Schedule through delivery, cost limits, realistic failure/retry tests, multiple isolated test users; complete personal local trial before deployment |
| 7 — production personal pilot | Cloudflare Worker/Cron + Neon + Telegram webhook, secrets, monitoring and cost visibility; verify a scheduled digest and on-demand conversation in production |
| Later — commercial launch | Website/PWA, registration/account linking, subscriptions, admin dashboard, additional channels and larger-scale infrastructure, under a separate scope |

Implement milestone by milestone only when requested. Integrate tests and usage accounting throughout; do not defer them to the last milestone.

## 11. Intended repository structure

```text
news-ai-agent/
  NEWS_AI_PROJECT_SPEC.md
  AGENTS.md
  README.md
  docs/
    ARCHITECTURE.md
    DATABASE.md
    NEWS_PIPELINE.md
    AI_CONTEXT_MEMORY.md
    TELEGRAM_FLOW.md
    COST_TRACKING.md
    ROADMAP.md
  src/
    config/
    domain/
    db/                 # repositories and typed access
    services/           # preferences, ranking, digest, conversation, delivery
    retrieval/          # RSS, Brave, normalization, deduplication, cache
    ai/                 # Luna client, prompts, output schemas
    context/            # intent-specific context assembly
    memory/             # consolidation, summaries, history retrieval
    usage/              # ledger, pricing, allowances
    jobs/               # scheduler, collection, digest, consolidation
    adapters/telegram/
    entrypoints/        # local runner, Worker HTTP/webhook, scheduled handler
  migrations/
  tests/                # unit, integration, end-to-end, fixtures
  scripts/
  .env.example
  package.json
  tsconfig.json
  wrangler.jsonc
```

This layout guides the authorized implementation. The initial specification task created only the specification; subsequent implementation is tracked by milestone in docs/ROADMAP.md. Add a web frontend later when separately scoped.

## 12. AGENTS.md guidance and coding principles

Future repository instructions should require Codex to:

- Read this specification and relevant docs before changes; preserve finalized decisions and document consequential deviations.
- Use GPT-5.6 Luna only for generative tasks, RSS + Brave for retrieval, Neon as state authority, and Telegram as V1 delivery.
- Separate deterministic retrieval/execution from LLM processing; use normal code for buttons, validation, deduplication, filtering, and accounting.
- Require confirmation for permanent preferences, including changes inferred through memory; never execute arbitrary model-supplied database operations.
- Build bounded, intent-specific context; preserve searchable archives and never send complete conversation history by default.
- Track every AI/search attempt and keep shared/private costs distinguishable.
- Enforce user isolation, validate inputs and structured outputs, keep secrets private, and implement idempotent jobs with bounded retries.
- Prefer small typed modules, explicit interfaces, transactional state changes, versioned migrations, structured logs, and simple testable functions over autonomous agents or speculative frameworks.
- Use Git from the start; deliver small milestone changes, run relevant checks, and keep docs aligned with implemented behavior.

For this current ChatGPT project mirror, files under `sources/` remain read-only and existing project instructions must not be overwritten. The future application AGENTS.md belongs in the implementation repository.

## 13. Testing approach

- Unit tests: URL normalization/deduplication, source/date filtering, ranking constraints, priority bounds, timezone/expiry behavior, token budgets, pricing calculations, and intent routing.
- Database integration: ownership enforcement, stale/replayed confirmation rejection, transactional preference updates, uniqueness/idempotency, archival search, and consolidation watermarks.
- Provider contracts: realistic RSS/Brave/Telegram/OpenAI fixtures; malformed responses, timeouts, rate limits, partial failures, invalid structured output, and bounded retries. Default tests must not spend money or send real messages.
- End-to-end scenarios: scheduled digest, existing-story follow-up with zero search calls, explicit new search, Confirm/Edit/Cancel, temporary F1 expiry, old NVIDIA conversation retrieval, and `/cost` reconciliation.
- Quality evaluation: small fixed story sets for source grounding, relevance, duplicate suppression, uncertainty labeling, and feedback behavior; test properties rather than exact LLM wording.
- Operational checks: two-user leakage attempts, malicious retrieved instructions, concurrent/repeated jobs, delivery uncertainty, budget exhaustion, and measured context sizes. Use limited opt-in live smoke tests after configuration; local acceptance precedes deployment.

## 14. Explicit V1 non-goals and unresolved choices

Out of scope: Claude or other generative models, multi-agent orchestration, built-in model web search, self-hosted SearXNG/search indexes, brittle search-page scraping as the product foundation, native mobile apps, WhatsApp/Discord/Slack/email adapters, public developer API, paid subscriptions, business/team product, polished commercial dashboard, Telegram Mini App, continuous breaking-news alerts, and premature Queues/Workflows. These were alternatives or later directions, not requirements for the personal V1.

Also prohibited: silent permanent preference learning, wholesale history prompting, automatic deletion merely because messages are old, invented citations, and treating historical cost estimates as current guarantees.

Before dependent live implementation, resolve: account-level Luna access, source/feed inventory, precise user settings and quotas, and runtime/deployment limits. The API ID and initial Luna text rates have been verified. Semantic embeddings require a separately chosen compatible model/provider and budget; keyword history retrieval is the initial default. Foundation defaults for testing, token ceilings, and confirmation expiry are recorded in docs/DECISIONS.md and docs/SETUP.md; consolidation batch size remains open. Do not change the locked product decisions silently.

