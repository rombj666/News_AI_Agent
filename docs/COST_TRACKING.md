# Cost tracking

Milestone 7: scheduled ranking and digest each enforce their configured monthly
job-type budget, including manual usage of that type. Telegram explanation and
preference interpretation use a separate conversation pool. All use the existing
atomic reservation/settlement service and `ai_usage`; shared Brave collection
retains account-wide budget/request limits. Default metering still supports the
conservative all-usage scope used by earlier commands. Unknown charges remain
reserved; no scheduler retry bypasses accounting. See [scheduling](SCHEDULING.md).

Every provider attempt has a stable operation ID and attempt number; retries use new attempts. Duplicate ledger writes for the same attempt are ignored. Store provider/model/job type, user/shared scope, request ID, status, input/cached/output tokens or search calls, rate snapshot, cost, duration, and timestamp. No prompt bodies or secrets in the ledger.

Use integer nanodollars to avoid floating-point accumulation. Cached input is a subset of input; price uncached and cached separately. Reject invalid token counts. Unknown usage produces unknown cost, and totals expose an unknown count. Shared collection spend is not charged once per user. Provider credits and invoices remain distinct from gross estimates.

Verified Luna standard text rates as of 2026-09-17: USD 0.20/M input, 0.02/M cached input, 1.20/M output. Source and caveats in DECISIONS.md. Initial code rejects unsupported large-input pricing rather than silently applying the small-input rate. No Brave pricing is assumed until its selected plan is verified.

Milestone 2 implements atomic Brave collection reservations through retrieval_runs, with write-ahead unknown usage and settlement in the existing ai_usage ledger. Each run makes at most one call. Gross per-request rate/version is mandatory configuration. Failed calls retain their reservation and unknown cost until reconciliation. RSS runs record zero external request fee without a paid-API ledger entry.

Implemented caps are a dedicated account-wide collection budget per UTC month and request count per UTC day, using all Brave runs in this database. They are not a combined AI/search budget or per-user subscription quota. Reservation uses a transaction-level advisory lock. Monthly totals use run start time. Repeated run IDs never create a new request/ledger row. Unknown/running records need review before rerunning under a new ID; automated invoice reconciliation is not implemented.

Local demo rows remain synthetic. Verify live rates against the actual plan; provider credits and infrastructure charges are separate from gross request estimates. Future LLM adapters still need reservation/settlement integration before use.
