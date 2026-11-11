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

## Proposed — awaiting confirmation

| # | Proposal | Depends on |
|---|---|---|
| P1 | Supabase (Mumbai region), Next.js web app, Expo Android field app | Developer confirmation |
| P2 | Email intake via Gmail API (Workspace) or auto-forward (plain Gmail) | Q1 |
| P3 | Evidence storage on Supabase Storage or Cloudflare R2 | Cost comparison |
| P4 | Default TAT of 15 days where an insurer has none configured | Insurer deadlines (Q7) |

## Open questions

| # | Question | Owner | Status |
|---|---|---|---|
| Q1 | Is the shared inbox Google Workspace or a plain @gmail.com account? | Client | Open |
| Q2 | How are cases tracked today (Excel, register)? Must open cases be migrated at go-live? | Client | Open |
| Q3 | Do all field operators use Android? Personal or company devices? | Client | Open |
| Q4 | Does any insurer require data residency in India or a fixed retention period? | Client | Open |
| Q5 | Which portal does the portal insurer use? API, bulk upload, OTP/captcha? | Client | Open |
| Q6 | Which insurer and operators will take part in the pilot? | Client | Open |
| Q7 | Turnaround deadline for each insurer | Client | Open |
| Q8 | Is storing ID documents as evidence files (not typed fields) acceptable? | Client | Open |
| Q9 | Typical number of evidence items per case | Client | Open |

## Answered

| # | Question | Answer |
|---|---|---|
| A1 | Email system | Gmail; single shared inbox |
| A2 | Insurers and volume | 10 insurers; ~300 cases/month |
| A3 | Current tooling | No forms; largely manual in MS Word |
| A4 | Field operators | ~10; comfortable in English |
| A5 | Report submission | Some insurers prescribe formats; one requires portal submission |
