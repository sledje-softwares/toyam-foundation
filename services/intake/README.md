# services/intake — email intake (M3)

```
Shared Gmail ──filter: insurer senders──► forward ──► Email Routing (intake@in.<firm domain>)
 (toyaminvestigation@gmail.com)                              │
      └──── hourly IMAP safety net (insurer senders) ───┐    ▼
                                                        Worker (email() push · scheduled() poll)
                                                             │ POST raw message
                                                             ▼
                                                        Edge Function `intake`   supabase/functions/intake
                                                                          │ store raw + attachments (email-raw)
                                                                          │ parse with _shared/intake (rules only)
                                                                          ▼
                                                     public.intake_ingest(decision)  — one transaction
                                                     new case · follow-up · internal · review · unmatched
```

| Part | Where | Runs on |
|---|---|---|
| Parser (pure, no dependencies) | `supabase/functions/_shared/intake/` | Deno (edge function) and Node (tests) |
| Edge function | `supabase/functions/intake/index.ts` | Supabase Edge Runtime |
| Intake Worker | `services/intake/worker/` (`email.ts` push, `relay.ts` + `imap.ts` safety net, `retry.ts` + `smtp.ts` retry queue) | Cloudflare Workers (Email Routing + hourly cron + 10-minute retry cron) |
| Template loader | `services/intake/scripts/load-templates.ts` | Node 22 |
| Database side | `supabase/migrations/20261113000200_intake.sql` | Postgres |
| Tests | `services/intake/test/` (parser, push handler, relay), `supabase/tests/08_intake.test.sql` | Node / pgTAP |

## Commands

```bash
npm test -w services/intake                       # parser, push and relay tests (Node >= 22.18, no build step)
npm run templates:json -w services/intake         # validate config/templates (dry run)
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run templates:load -w services/intake
npx -y supabase@3.1.0 functions serve intake --env-file supabase/functions/.env   # local function
```

Post a fixture to the local function:

```bash
curl -s -X POST http://127.0.0.1:54321/functions/v1/intake \
  -H "x-intake-secret: $INTAKE_SECRET" -H 'content-type: message/rfc822' \
  --data-binary @services/intake/test/fixtures/igi-new-od.eml
```

## Decisions the parser makes

| Action | When | Database result |
|---|---|---|
| `internal` | From the firm's own domains / addresses (`app_settings`) | Linked to the case of its thread, if any; never a case |
| `unmatched` | Sender domain belongs to no insurer | Email `ignored` |
| `attach_to_case` | `Re:` / `Fw:` subject or `In-Reply-To` | Attached by Gmail thread, reply chain or claim no.; otherwise review |
| `create_case` | New mail, template matched by subject pattern, all required intake fields found | Case + field values + insured/driver parties + insurer files as evidence; auto-assigned |
| `review` | Known insurer but no template / unknown variant / required field missing | `intake_extractions` pending review; orchestrators notified; office confirms or dismisses |

Values come from (in order) the subject pattern groups, the label/value table (HTML; plain text as a fallback with lower confidence), the investigation-points block, then optional regexes. A field label can be limited to a block (`within: Insured Details`), which is how "Mobile Number" of the insured is told apart from the intimator's.

Insurer attachments become case evidence unless they are signature images (inline, referenced by `cid:`, under 60 KB) or `.ics` / `.p7s` / `winmail.dat`. File-name rules in `_categories.yaml` then label them for free.

## Failure handling

- The same mail usually arrives twice (push now, safety net within the hour). The function looks the Message-ID up first and answers `duplicate` without storing anything; attachments are content-addressed under `emails/att/`, so even a race stores each file once.
- Storage or database errors → the function answers 500. Push does **not** bounce the mail (Gmail would warn the account); the hourly safety net delivers it again. The poll keeps its UID and retries next hour. Every step is idempotent.
- Undecodable message or parser exception → a `failed` email row with the error (visible to staff), answer 200 so one bad message cannot block the inbox.

## Queued retry (D39)

```
staff: request_intake_retry(email)   failed → retry_requested (who / when, audited; nothing deleted)
Worker cron */10 ─► POST intake?op=claim-retries&limit=RETRY_BATCH   claim_intake_retries(): lease 15 min
                ─► POST intake?retry=<email id>  (each)              reprocess into the same row:
                                                                     processed / ignored, or failed + attempts
                ─► POST intake?op=escalate-retries                   escalate_stuck_intake_retries()
                ─► one alert email per returned email (ALERT_EMAIL)
```

- All three calls carry `x-intake-secret`; the Worker never holds a service-role key and the web app holds neither.
- A retry ends `processed` / `ignored` (ingested) or `failed` with `retry_attempts` + 1 and the new error. If the Worker dies mid-run the lease expires and the next run claims it again. If the same Message-ID was ingested meanwhile, the retried row is closed as `ignored` (no duplicate case).
- **Alerts:** a retry still `retry_requested` after `app_settings.intake_retry_alert_minutes` (60) or `failed` again → one in-app notification (`kind = intake_retry_stuck`) per active orchestrator and admin, once per request (`retry_alerted_at`), then one email to the shared inbox: subject `[Toyam alert] Intake retry stuck`, body sender / subject / received / attempts / `/intake/failed` (prefixed with `APP_URL` if set).
- **Alert email transport** (`ALERT_EMAIL` in `wrangler.jsonc`): `smtp` = Gmail submission at `smtp.gmail.com:465` with `GMAIL_USER` / `GMAIL_APP_PASSWORD` (the IMAP secrets; no DNS needed, sent from and to the shared inbox, `ALERT_TO` overrides the recipient); `off` = in-app alerts only, each skipped email is logged as `{"mode":"retry-alert","skipped":…}`. A failed send is logged and not repeated (the in-app alert stands). Cloudflare `send_email` could replace SMTP once Email Routing exists (Q14).
- Manual run: `POST <worker>/retry` with `x-intake-secret`.
- **Report send sweep (8.2)** on the same `*/10` cron (`worker/send-sweep.ts`): `POST REPORT_SEND_URL {action:"sweep"}` with header `x-send-secret: SEND_SECRET`. Off while `REPORT_SEND_URL` (var) or `SEND_SECRET` (secret) is empty. The Worker holds no service-role key and sends no report mail itself; contract in `supabase/functions/report-send/README.md`. Manual run: `POST <worker>/send-sweep` with `x-intake-secret`.

## Deployment

1. **Database:** apply migrations; set `app_settings.internal_email_domains / internal_email_addresses` if they differ.
2. **Templates:** `npm run templates:load` against the project (service-role key from the dashboard; never commit it).
3. **Function:** `npx -y supabase@3.1.0 secrets set INTAKE_SECRET=<long random>` then `npx -y supabase@3.1.0 functions deploy intake` (`verify_jwt = false` in `config.toml`; the secret header protects it).
4. **Gmail (safety net):** enable IMAP, turn on 2-step verification and create an **app password** for the shared account.
5. **Worker:** `npx wrangler kv namespace create STATE` → put the id and the function URL in `worker/wrangler.jsonc`; set `ONLY_FROM` to the insurer domains; `npx wrangler secret put GMAIL_USER`, `GMAIL_APP_PASSWORD`, `INTAKE_SECRET`; `npm run worker:deploy -w services/intake`. The first poll only records the current position; set `BACKFILL_SINCE` (e.g. `01-Nov-2026`) for a one-off import of recent mail.
6. **Email Routing (push, needs the firm's DNS — Q14):** add the domain (or a subdomain such as `in.toyaminvestigation.in`) to Cloudflare, enable Email Routing for that subdomain only (the existing `gi@` mailbox keeps its MX), create the custom address `intake@in.toyaminvestigation.in` → *Send to a Worker* → `toyam-intake-relay`.
7. **Gmail forwarding:** Settings → Forwarding → add `intake@in.toyaminvestigation.in`. Google sends a confirmation mail: the Worker logs `{"kind":"confirmation","code":…,"link":…}` (`npx wrangler tail`); confirm with that code. Then create a filter *From:* `indusindinsurance.com OR icicilombard.com` (all insurer domains) → *Forward it to* the intake address. Keep the filter's sender list and `ONLY_FROM` the same.
8. **Smoke test:** send a test mail from an insurer-like address through the filter; check `emails` and `npx wrangler tail`. POST to the Worker with the secret header to run one safety-net poll.

## Known limits

- Validated on anonymised fixtures shaped like the samples and on the **text** of the Gmail print-outs (all required fields found for 4/4 OD samples; THEFT correctly sent to review). Long values wrapped by the print layout come out cut short — the real path reads the HTML tables. **Raw `.eml` exports of real mails are needed to confirm the HTML path (Q19).**
- The Worker's IMAP client is tested against a scripted Gmail server, not yet against Gmail itself; the push handler is tested in Node, not yet behind real Email Routing. Watch CPU time on the free plan (10 ms per invocation); push handles one message per invocation, the hourly poll may need a lower `MAX_PER_RUN` with large attachments.
- The push path trusts the envelope sender (the shared Gmail's forwarding address). Insurer DKIM signatures survive forwarding and could be verified later for stronger assurance.
- Mail that does not match the Gmail filter (a new insurer domain) is not pushed; add the domain to the filter **and** `ONLY_FROM` when an insurer is added.
- Reply detection relies on `Re:` / `Fw:` / `In-Reply-To`; an insurer that starts a new thread for the same claim is still matched by claim number.
