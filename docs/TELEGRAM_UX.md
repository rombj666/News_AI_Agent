# Telegram UX before deployment

`/start` shows actual saved digest/style, delivery enablement/time/timezone and
main topic/region preferences. Empty fields show Not set. `/preferences` adds
language, source priorities and detailed lists. `/help` is only a compatibility
redirect to `/start`. Bot/scheduler startup registers start, news, preferences as
the default Telegram command menu; no live menu change was made during development.

With conversational AI enabled, natural-language schedule requests use the existing
metered preference interpreter and pending preference system. Examples: Send my
news at 8:30 AM, Change my briefing to 6 PM, Stop automatic delivery, Turn automatic
delivery back on, Use UK time, Make my digest quick, Send me a deep digest.
Only one requested field is proposed at a time. UK time maps to Europe/London
for DST. Ambiguous times require clarification. Changing time does not implicitly
enable delivery. Confirm/Cancel retains ownership, expiry and version checks.

New digest generation asks for one short plain-language summary sentence and one
why-it-matters sentence, without headline repetition or unnecessary excerpt caveats.
Factual caution and grounded evidence checks remain. Existing saved prose is not
rewritten or blindly truncated; regenerate through an explicit authorized workflow
to obtain the new style. Telegram section labels and source/action rows are compact.

Explain targets 40–80 words, with Why this matters and an optional What to watch.
The short mode rejects outputs over 100 whitespace-delimited words. Explicit
deeper/detail/background requests allow a longer answer. The last explained story
is remembered for follow-ups; otherwise specify a story number. Only stored source
context is used, with no new retrieval. Usage accounting is unchanged.

## Optional images

Migration 0008 adds nullable `articles.image_url` and an optional last-story
position on Telegram sessions. RSS media/content, thumbnails and image enclosures
provide URLs. Normalization and persistence carry images through cluster source
selection into saved digests, preferring the representative source. Older articles
and digests work without images. No page scraping, Open Graph enrichment, artificial
images, binary downloads, proxying or local image storage is introduced.

Only bounded public HTTPS URLs without credentials or credential-like query keys
are accepted. Unsupported known extensions are omitted. Telegram's photo decoder
validates the actual remotely fetched format. Captions use escaped HTML and a
conservative 1,024-character limit; longer stories use normal text splitting with
buttons. A definite Telegram 400/413/415/422 photo rejection falls back once to text and logs
`TELEGRAM_IMAGE_REJECTED_TEXT_FALLBACK`. No provider body/URL is logged.

A timeout or malformed success is uncertain: automatic text fallback could send
the story twice. Existing uncertain-delivery handling therefore applies instead;
the saved digest remains available via `/news`. Exactly-once delivery cannot be
guaranteed by Telegram. No local image fetch is required.

## Manual acceptance

Restart the local bot/scheduler (one process only) to apply migration/menu updates.
Check `/start`, `/preferences`, `/help`; propose a new time, Cancel it, then propose
again and Confirm. Check the saved schedule. Deliver a newly generated digest
containing RSS images, use all four buttons, then request Explain deeper. Image
availability depends on source metadata; existing saved digests may have none.
Normal tests and `demo:telegram` remain offline. No deployment was performed.

Validation: TypeScript check and all 152 offline tests passed. The Telegram demo
showed the saved overview, detailed settings, a mocked photo, rejected-photo text
fallback, concise Explain, and a schedule proposal confirmed to 08:30. Actual
provider cost was $0; live Telegram/image acceptance remains a manual check.
