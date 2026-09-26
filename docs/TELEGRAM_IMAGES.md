# Local image refresh and explicit digest regeneration

Stop `scheduler:dev` / `telegram:dev` before opening the shared local database.

```powershell
npm run images:diagnose
npm run images:diagnose -- --refresh-rss
npm run digest:telegram-user -- --force
npm run images:diagnose
npm run scheduler:dev
```

`images:diagnose` reads the enabled BBC Technology RSS feed (at most 100 items),
the stored article pool, deterministic fresh candidates, and the existing allowed
Telegram user's latest saved digest. Output contains counts only. No AI, Brave,
Telegram sends, or identity creation. `--refresh-rss` explicitly persists eligible
feed items through the normal RSS collection/deduplication path, bypassing feed
validators so previously stored duplicates can acquire missing image metadata.
The refresh uses the existing seven-day retrieval window; digest candidates still
require normal strict freshness. Stale RSS entries are not made fresh.

Images enrich NULL article fields only. Missing/new images never replace an
existing valid image. RSS media thumbnails may use extensionless HTTPS URLs;
normal URL safety validation still applies. Clusters keep their normal quality
representative; digest source loading reads that representative's current image
first, then other eligible member sources. Images are server-owned metadata, not
model-generated links. Saved digests are immutable snapshots and need explicit
regeneration to acquire newly enriched images.

`digest:telegram-user` retains its existing UTC-day replay protection. Only an
explicit `--force` bypasses today's completed/failed manual digest check. Running
attempts stay protected. The command resolves the existing allowed Telegram user,
uses a fresh rolling 24-hour stored-news window, reuses eligible owned rankings
or performs one metered ranking, and generates one metered NORMAL digest. It does
not retrieve news, send messages, reset scheduler claims, or change `/news` into
an AI operation. Each explicit force invocation can incur normal OpenAI costs.

Telegram menu startup retries temporary errors at most three times with bounded
backoff, then defers optional menu setup and proceeds to polling. Authentication
and other permanent 4xx errors still stop startup. Polling retains its separate
reconnect/recovered diagnostics and capped network backoff. Message sends are
never retried after uncertain outcomes. A definite photo rejection falls back
once to text, with the existing delivery claim preventing duplicate processing.

Live inspection on 2026-09-26: BBC feed had 21/21 image-bearing items. Before
refresh: 10/36 stored articles, 4/5 fresh candidates, 0/4 saved digest items had
images. After refresh: 15/40 stored articles, 5/5 fresh candidates (including all
five representatives), and 0/4 saved digest items. No paid digest regeneration
was performed during this verification; run the explicit force command above.
The old digest remains available until a new generation succeeds.

Retest in Telegram with `/news`: check photos with concise captions and source/
feedback/Explain buttons. Read Source and feedback do not invoke AI; Explain is
metered. Real source-image acceptance depends on Telegram fetching that image.
Offline tests exercise image success, no-image text, definite rejection fallback,
uncertain no-retry delivery, startup recovery, duplicate enrichment and metering.

Validation: `npm run check`, all 165 offline tests, `npm run demo:telegram`,
`npm run demo:quality`, and `npm run demo` passed. The three new focused tests
also passed after adding long server-cooldown handling to menu setup.
