# 07 — Decisions and Open Questions

## Decision log

| # | Date | Decision | Rationale |
|---|---|---|---|
| D1 | 2026-11-11 | Phase 1 = intake, case management, field app, report upload, submission tracking | Removes the largest hand-off delays first |
| D2 | 2026-11-11 | Case + task model; fixed short status list | Investigation flows are highly dynamic |
| D3 | 2026-11-11 | Evidence immutable at database level; SHA-256 and server time on every item | Evidence integrity and defensibility |
| D4 | 2026-11-11 | AI suggests, staff confirm; conclusions remain human | Accuracy and accountability to insurers |
| D5 | 2026-11-11 | Pre-filled Word report templates in Phase 1; AI drafting in Phase 2 | Early saving at low cost; templates reused in Phase 2 |
| D6 | 2026-11-11 | Portal insurer: manual upload with portal pack in Phase 1; automation in Phase 3 | Portal access details unknown |
| D7 | 2026-11-11 | English-only field app interface | Operators comfortable in English; transcription later must handle regional languages |
| D8 | 2026-11-11 | No government ID number columns | Data minimisation |
| D9 | 2026-11-11 | Sizing basis: 300 cases/month, 10 operators, ~1 case/operator/day | Confirmed by the client |
| D10 | 2026-11-11 | Supabase (Mumbai, `ap-south-1`), Next.js web app, Expo Android field app; free tiers during development. Dev project `toyam-dev` (ref `ezycvkthddhqtwtqvmlg`) | Confirms P1 |
| D11 | 2026-11-11 | Web app hosted on Cloudflare Workers via the OpenNext adapter (free plan during development) | Developer choice |
| D12 | 2026-11-11 | Shared inbox is a plain @gmail.com account; intake runs on Cloudflare. **Until a domain exists:** a Cloudflare Worker on a 1-minute cron polls Gmail over IMAP (app password as Worker secret) and relays each raw message to a Supabase Edge Function, which parses and stores it. **Once a domain exists:** Gmail auto-forward → Cloudflare Email Routing → the same Worker's email handler. Worker only relays (free plan 10 ms CPU limit) | Answers Q1; no domain needed to start; no Google restricted-scope assessment; no paid plan |
| D13 | 2026-11-11 | Stay on free tiers during build and pilot. Evidence files on Cloudflare R2 (10 GB free, no egress); Supabase Storage only for raw emails and reports. Daily archive sync to the admin's PC downloads and hash-verifies all files and takes a database backup; cloud copies of evidence are purged only after verified archive **and** ≥7 days after submission. Evidence records are never deleted | Keeps cost at zero; free Supabase (1 GB storage, 5 GB egress, no backups) cannot hold or serve evidence volume |

## Proposed — awaiting confirmation

| # | Proposal | Depends on |
|---|---|---|
| P5 | Move to paid plans (Supabase Pro for prod, backups and no auto-pause; R2 beyond 10 GB) — **decision deferred to before go-live** (D13). Note: free plan allows 2 active projects and one is used by another project | Pilot volumes; budget |
| P6 | A domain on Cloudflare for Email Routing (intake address) and the web app (~₹800–1,200/yr; no Cloudflare plan cost) | Domain choice |
| P4 | Default TAT of 15 days where an insurer has none configured | Insurer deadlines (Q7) |

## Open questions

| # | Question | Owner | Status |
|---|---|---|---|
| Q2 | How are cases tracked today (Excel, register)? Must open cases be migrated at go-live? | Client | Open |
| Q3 | Do all field operators use Android? Personal or company devices? | Client | Open |
| Q4 | Does any insurer require data residency in India or a fixed retention period? | Client | Open |
| Q5 | Which portal does the portal insurer use? API, bulk upload, OTP/captcha? | Client | Open |
| Q6 | Which insurer and operators will take part in the pilot? | Client | Open |
| Q7 | Turnaround deadline for each insurer | Client | Open |
| Q8 | Is storing ID documents as evidence files (not typed fields) acceptable? | Client | Open |
| Q9 | Typical number of evidence items per case | Client | Open |
| Q10 | Client accepts that the admin's PC becomes the master evidence archive and will keep it encrypted with a second copy (external drive/NAS)? | Client | Open |

## Answered

| # | Question | Answer |
|---|---|---|
| A1 | Email system | Gmail; single shared inbox |
| A6 | Q1 — Workspace or plain Gmail? | Plain @gmail.com (see D12) |
| A2 | Insurers and volume | 10 insurers; ~300 cases/month |
| A3 | Current tooling | No forms; largely manual in MS Word |
| A4 | Field operators | ~10; comfortable in English |
| A5 | Report submission | Some insurers prescribe formats; one requires portal submission |
