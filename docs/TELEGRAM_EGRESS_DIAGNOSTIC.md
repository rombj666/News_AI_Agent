# Production Telegram egress diagnostic

This temporary diagnostic distinguishes Cloudflare fetch-handler egress from
scheduled-handler egress. It calls Telegram `getMe`; it never sends a visible
message, reads Neon, processes the inbox, or logs the token or response body.

Deploy with `TELEGRAM_EGRESS_DIAGNOSTIC` left as `NO`, start a tail, then invoke:

```powershell
$healthSecret = Read-Host 'PRODUCTION_HEALTH_SECRET'
$workerUrl = Read-Host 'Worker origin, for example https://name.account.workers.dev'
$headers = @{ Authorization = "Bearer $healthSecret" }
Invoke-RestMethod -Method Post -Uri "$workerUrl/diagnostics/telegram-egress" -Headers $headers
```

The JSON result is limited to `reached`, HTTP `status`, normalized
`contentType`, response `bytes`, and a fixed category. The tail prints
`FETCH_HANDLER_EGRESS = PASS` or `FAIL`.

To isolate the scheduled event, temporarily change
`TELEGRAM_EGRESS_DIAGNOSTIC` in `wrangler.jsonc` from `NO` to `YES`, deploy, and
watch one cron invocation. While this gate is `YES`, scheduled invocations run
only `getMe`; they do not process inbox updates or scheduled news. The tail
prints `SCHEDULED_HANDLER_EGRESS = PASS` or `FAIL` plus sanitized metadata.
Immediately restore the value to `NO` and deploy again after recording one
result.

Do not send `/start` during the diagnostic deployment. Select the production
fix only after both results are known:

- fetch PASS / scheduled FAIL: process interactive persisted updates via the
  fetch handler's `waitUntil`; retain cron for scheduled news and abandoned-row
  recovery.
- fetch PASS / scheduled PASS: compare `TelegramApi` lifecycle with the proven
  minimal fetch.
- fetch FAIL / scheduled FAIL: Cloudflare cannot reach Telegram from either
  handler; use an authenticated, method-allowlisted external relay.

The current production runtime releases each Neon transaction before calling
Telegram. The runtime pool can retain an idle WebSocket briefly, but no runtime,
collector, or quality transaction spans the interactive Telegram fetch.
