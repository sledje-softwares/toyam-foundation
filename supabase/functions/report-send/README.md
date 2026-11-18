# `report-send` — report email on the insurer's thread (build plan 8.2, D50)

Sends a queued report email (`report_sends`, migration `20261116100000_report_send.sql`, test mode
`20261119210000_report_send_test_mode.sql`) through Gmail SMTP as a **reply on the insurer's thread**, and
records the outcome. Flow and no-duplicate rules: `../_shared/report-send/handler.ts`; pure parts:
`../_shared/report-send/logic.ts`; MIME / SMTP / delivery plan: `../_shared/send/`. Tests:
`services/intake/test/report-send-function.test.ts` (fake gateway + scripted SMTP server; no real mail).

## How a send starts

1. Staff fill **Send to insurer** on `/reports/[caseRef]` (approved latest version). The server action calls
   `request_report_send(...)` with the user's session: the database checks the role, case ownership (D44),
   approval, formats, an insurer mail to reply to, and that no other send of that report is open. Reply headers
   (`In-Reply-To`, `References`, thread id) are copied from the insurer's latest mail by the database.
2. The same action calls this function with `{ action: "send", id }` and the **user's access token**. The function
   checks the token (`auth.getUser`) and that the user can read the send row under RLS, answers **202** at once
   and delivers in the background (`EdgeRuntime.waitUntil`).
3. **Fallback:** the intake Worker's `*/10` cron (`services/intake/worker/send-sweep.ts`) calls
   `{ action: "sweep" }` with the `x-send-secret` header. The sweep settles expired claims and sends up to
   `SEND_SWEEP_BATCH` (default 3) queued rows, oldest first. A send the web app could not start goes out within
   10 minutes.

`verify_jwt = false` in `config.toml` because the sweep caller has no user JWT; the `send` and `mode` actions check
the token themselves. The **service-role key stays inside the function** (claim / complete / fail, reading the queue
and the `reports` bucket) and is never returned or logged (rule 4). The web app holds no secret for this.

```
POST /functions/v1/report-send
Authorization: Bearer <staff access token>          { "action": "send", "id": "<report_sends.id>" }
   202 { ok: true, accepted: true, mode: "test" | "live", test_to: string | null }
   401 unauthorized · 404 not_found (not visible to the caller) · 409 not_queued (+ status) · 503 not_configured

Authorization: Bearer <staff access token>          { "action": "mode" }
   200 { ok: true, configured: boolean, mode: "test" | "live" | null, test_to: string | null }   (staff only, 403 otherwise)

x-send-secret: <SEND_SECRET>                        { "action": "sweep" }
   200 { ok: true, mode, results: [ { id, outcome: "sent" | "test_sent" | "failed" | "unknown" | "skipped" | "error" } ] }
   401 wrong / missing secret · 503 not_configured
```

## Delivering one send

1. `claim_report_send(id, <uuid@sender-domain>, test_recipient)` — leases the row (`sending`); the Message-ID is fixed
   at the first claim and kept on every retry. A row claimed more than `send_lease_minutes` (10) ago and never
   finished becomes `unknown` here (nothing is sent).
2. Files: `report_files` of the claimed report version, one per chosen format, downloaded from the `reports` bucket
   (`{case_id}/{report_id}/report.{pdf|docx}`, recorded by `create_report_version`). Each must have a recorded
   SHA-256, the recorded size and the same SHA-256 after download, else the send **fails** and nothing is sent.
3. Size (8.3): the report files together must fit `send_attach_max_mb` (18 MB, before encoding). **Secure links are
   not built yet**: a larger report fails with a clear message (deliver another way and record it on Submissions).
   Annexure zips are not attached (the report already embeds its photos).
4. MIME (`_shared/send/mime.ts`): From `SEND_FROM_NAME <SMTP_USER>`, To / Cc from the row, subject and body as staff
   wrote them, attachments `<attachment_name>.pdf|.docx`, `In-Reply-To` / `References` from the row.
5. SMTP (`_shared/send/smtp.ts`) over `Deno.connectTls(smtp.gmail.com:465)` (Supabase Edge blocks only 25 / 587),
   AUTH PLAIN with the app password, one RCPT per recipient.

| What happened | Recorded as | Notes |
|---|---|---|
| Problem before SMTP (file, hash, size, config, connect) | `failed` | Nothing left; staff may retry (same Message-ID) |
| Server refused before the body, or answered 5xx to it | `failed` | Nothing delivered |
| Body handed over, final answer lost | `unknown` | **Never resent by itself.** A person checks the shared Gmail's Sent folder and settles it (`resolve_report_send`; orchestrator / admin in the UI) |
| Accepted | `sent` + submission (channel email) in the same transaction | `complete_report_send`; the case becomes `submitted` |
| Accepted but the database did not answer (3 tries) | stays `sending` → `unknown` after the lease | Logged `MAIL ACCEPTED BUT NOT RECORDED`; settle it as sent |
| Accepted in **test mode** | `test_sent`, **no submission**, case unchanged | Staff-only thread message names the test address |

## Test mode (default)

The only Gmail available during the build is a developer test inbox, and the To / Cc of a real case are insurer
addresses. So the function runs in **test mode unless `SEND_MODE=live`**:

- every To / Cc is replaced by `SEND_TEST_TO` (RCPT and headers; the code refuses an envelope with any other address),
- the subject gets `[TEST] `, and the body starts with the real recipients, the case ref and the subject,
- reply headers are kept (threading can be checked in the test inbox),
- the claim records `test_recipient`; the database finishes the row as `test_sent` with **no submission** and no case
  status change (also when an `unknown` test run is settled as sent). The report can be queued again, and the audit
  log keeps every run. The web page shows a **Test mode** notice and "Send test email".

The function **refuses to start** (every `send` / `sweep` answers `not_configured`, nothing is claimed) when
`SEND_MODE` is not `test` / `live` / absent, when test mode has no single valid `SEND_TEST_TO`, when
`SEND_MODE=live` while `SEND_TEST_TO` is still set, or when `SMTP_USER` / `SMTP_PASSWORD` are missing. Queued sends
wait until it is configured.

## Limits

- Edge limits: 2 s CPU, 256 MB memory, 150 s (free) / 400 s (paid) wall clock per request (background work
  included). An 18 MB attachment set means ~25 MB of base64 in memory several times over (≈ 150 MB peak) and some
  hundred ms of CPU for encoding; **time a large real report on the hosted project** before relying on the limit.
- Gmail: 25 MB per message, ~500 recipients a day for a plain Gmail account.

## Deployment (not done; needs the user's approval)

1. Function secrets (hosted project):
   ```
   npx -y supabase@3.1.0 secrets set SMTP_USER=<gmail address> SMTP_PASSWORD=<16-char app password> \
       SEND_MODE=test SEND_TEST_TO=<developer inbox> SEND_SECRET=<random 32+ chars>
   # optional: SEND_FROM_NAME="Toyam Investigation and Valuation Pvt. Ltd" SEND_SWEEP_BATCH=3
   ```
   In test mode `SMTP_USER` is the developer test Gmail; for production it is the firm's shared Gmail.
2. Push the migration `20261119210000_report_send_test_mode.sql` (`db push --linked --yes`), then
   `npx -y supabase@3.1.0 functions deploy report-send --use-api --yes` (`verify_jwt = false` comes from config.toml).
3. Worker sweep: `npx wrangler secret put SEND_SECRET` (same value) on `toyam-intake-relay`, set
   `REPORT_SEND_URL=https://<ref>.supabase.co/functions/v1/report-send` in `services/intake/worker/wrangler.jsonc`
   (or `--var`), redeploy. Empty `REPORT_SEND_URL` keeps the sweep off. Manual run: `POST /send-sweep` with
   `x-intake-secret`.
4. Web: nothing to configure (it calls the function with the user's session); redeploy `toyam-web`.
5. **Going live** (separate approval): first make sure no send from the test period is still `queued` or `failed`
   (`select id, case_id, status from report_sends where status in ('queued', 'failed', 'unknown')`): after the switch
   a queued row, or a failed one someone retries, goes to the insurer. Then `secrets unset SEND_TEST_TO`,
   `secrets set SEND_MODE=live`, and point `SMTP_USER` / `SMTP_PASSWORD` at the firm's Gmail. Check one real send in
   the Sent folder and on the insurer's thread.
