# Manual digest for the existing Telegram user

Stop `telegram:dev` with Ctrl+C before accessing its PGlite database from another
process. Run `npm run digest:telegram-user -- --inspect` to print the allowed
Telegram ID, existing application user ID, digest ownership counts, and article
availability without AI calls. With multiple allowed IDs, explicitly select
`LIVE_TELEGRAM_USER_ID`. The command never creates a user.

Run `npm run digest:telegram-user` to explicitly authorize up to one ranking and
one NORMAL digest using `gpt-5.6-luna`, saved in `.local/retrieval-live-db`.
Requires `OPENAI_API_KEY` and `OPENAI_TELEGRAM_MONTHLY_BUDGET_NANODOLLARS` in `.env`.
Uses the same configured input/output ceilings and monthly user accounting as
Telegram AI. It does not require enabling conversational AI or changing saved
digest-length preferences. The explicit command itself is the billable opt-in.

Existing eligible owned rankings are reused. Otherwise up to 12 fresh stored
clusters are ranked in one bounded request; input limits can reduce that count.
NORMAL targets 12 stories, but available evidence and token limits can yield fewer.
The briefing covers the preceding 24 hours. A NORMAL digest already created today
(UTC) is reused without billing. An existing failed/running digest for today blocks
automatic retries. Every actual AI attempt uses the normal reservation/usage ledger.

No retrieval occurs inside this command. If there are no fresh candidates, refresh
RSS separately, only after the command/inspection establishes that need:

```powershell
$env:RUN_LIVE_RETRIEVAL = 'YES'
$env:LIVE_RETRIEVAL_PROVIDER = 'rss'
$env:LIVE_RSS_SOURCE_ID = 'bbc-technology'
npm run test:live:retrieval
npm run digest:telegram-user
npm run telegram:dev
```

The selected feed must be enabled in `config/rss-sources.json`. RSS may still have
no qualifying fresh items; freshness is never relaxed. No Brave request is made
in RSS-only mode. Restart polling only after the other commands finish, then send
`/news`. No scheduling, webhook, automatic billable `/news` behavior, or deployment
is introduced.

Validation: TypeScript check, all 123 offline tests, foundation demo and Telegram
demo passed. Local ownership inspection found the allowed Telegram user's account
had no digest, while one digest belonged to another application user. There were
25 stored articles and zero explicitly published in the preceding 24 hours.
No live generation or retrieval was performed during this verification.
# Image refresh follow-up

To replace today's saved digest after enriching images, stop the local bot and
run `npm run images:diagnose -- --refresh-rss`, then
`npm run digest:telegram-user -- --force`. The explicit force flag permits one
new metered generation; without it the existing daily replay protection remains.
See [image workflow and verification](TELEGRAM_IMAGES.md).
