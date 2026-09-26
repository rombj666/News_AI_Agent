# Telegram live failure diagnosis

## Evidence

The failed `/news` update at 2026-09-26 05:38:32 UTC stopped on part 0: a
32-character plain-text header with no photo or keyboard. Delivery was uncertain.
Its owned saved digest renders correctly into five text parts; all four stories
are under 455 escaped HTML characters and callback data is 40 bytes. No photos
exist in this saved digest. It previously delivered successfully through both
`/news` and the scheduler. Thus image rejection, caption limits, story keyboards
and missing digest ownership did not cause this particular failure.

A read-only live probe reproduced `CONNECTION_RESET`. The next two probes
succeeded; no webhook was configured. This demonstrates intermittent transport
failure. The old send record discarded its exception, so the exact historical
socket error cannot be recovered or conclusively equated to that reset.

The adjacent application error came from a successfully metered topic preference
interpretation requesting the already saved priority. This is `NO_CHANGE`, now
reported as a normal "already set" reply, separate from the delivery problem.

## Fixes and limits

- Fixed-code diagnostics distinguish photo/message/render errors, HTML, length,
  keyboards, photo fetch/format, rate limits, access, conflicts, timeouts and
  exposed socket/DNS errors. Raw Telegram descriptions, URLs and secrets are
  never printed. Unknown errors remain unknown.
- Migration 0009 adds safe `error_code` columns to updates and deliveries.
  Historical null codes remain unknown.
- Scheduled sends and chat replies share one serial pacing queue, including
  fallback. This removes a possible local pacing race; it does not repair the
  external connection itself.
- Photo rejection with 400/413/415/422 falls back once to text with the same
  keyboard. Resets, timeouts and malformed successful responses remain uncertain
  and are never automatically retried. Auth/rate-limit failures are not retried
  immediately as text.
- Malformed saved digests produce a safe reply and persisted failure state.
  Missing optional image fields remain compatible with old digests.
- Poll logs include safe reason, consecutive failures, delay and recovery.
  Fatal auth/conflict errors stop. Duplicate updates remain protected.

## Commands and retest

Stop the bot before opening its PGlite database:

```powershell
npm run telegram:diagnose
# Optional getMe/getWebhookInfo probes: no sends, no getUpdates, no AI.
npm run telegram:diagnose -- --probe
```

Restart `npm run scheduler:dev` using the existing configured opt-in, then send
a new `/start` and `/news`. Confirm receipt of the header and four saved stories.
No regeneration is needed. The old failed update is not replayed; a new message
is an explicit new request. Stop the scheduler before running diagnostics again.

`npm run demo:telegram` verifies photo rejection fallback offline. This particular
live digest has no images and cannot verify live photo delivery. Wait for an
image-bearing digest to test that path live.

One poll reset followed by recovery is recoverable; recurring resets affecting
sends are an availability issue, not harmless noise. Old logs cannot establish
their frequency. Use the new counters/recovery messages and investigate the local
network/proxy/VPN path if failures persist. Do not clear idempotency claims.

Validation: TypeScript check, all 162 offline tests and the Telegram demo passed.
No paid provider calls, Telegram sends or deployment occurred during diagnosis;
only read-only connection probes contacted Telegram. `/news` succeeds in offline
tests, including a fresh request after a simulated connection reset. Live recovery
still requires the retest above.
