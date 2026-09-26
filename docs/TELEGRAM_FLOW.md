# Telegram flow

Delivery diagnostics retain sanitized reasons and distinguish photo/message/
render failures and poll recovery. See [live diagnosis](TELEGRAM_DIAGNOSTICS.md).
Uncertain sends remain protected against automatic retries.

Current UX details: [TELEGRAM_UX.md](TELEGRAM_UX.md). Natural-language schedule
changes reuse confirmed proposals; `/start` is the overview and `/preferences`
the detailed view. Default menu: start/news/preferences. Optional RSS images use
sendPhoto with safe rejection fallback and the existing delivery accounting.

Current state: Milestone 6 is user-reported live verified. Commands, feedback,
stored-story explanations and confirmed preference changes run locally.
Milestone 7 adds direct scheduled delivery and integrated polling; see
[SCHEDULING.md](SCHEDULING.md). The historical planning notes below describe
additional future commands/webhook work, not the current local scheduler.

Planned live adapter: milestone 4. Commands: /news, /preferences, /topics, /search, /ask, /history, /cost. The foundation only validates/allowlists an identity; it does not receive or send Telegram messages.

Verify webhook secret, validate update, require a private chat and an allowlisted sender for the personal pilot, persist update identity to deduplicate, then route. Buttons use stable owner-checked article/digest/proposal references and do not require a model call.

1. Existing article question: resolve reference, use stored content, answer; no unnecessary search.
2. Explicit latest search: check cache and allowance, then Brave + Luna. Ambiguous freshness request offers Search Latest.
3. Permanent preference request: validated diff -> pending proposal -> Confirm/Edit/Cancel. Confirmation immediately updates the database and increments profile version. Reject another user's, expired, replayed, or stale proposal.

Temporary requests need an explicit interval; ambiguity is clarified. More/Less Like This records feedback without silently rewriting preferences. Read Source opens the genuine source URL. Long digests split with stable numbering; full-briefing web links appear only when implemented.

Before enabling delivery: persist the digest, track attempts/message IDs, handle uncertain send outcomes, bound retries, and prevent known duplicates. Telegram has no assumed exactly-once delivery guarantee.
