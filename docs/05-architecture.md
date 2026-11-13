# 05 — Architecture (Phase 1, proposed)

Status: **confirmed** (D10–D12 in `07-decisions-and-open-questions.md`): Supabase Mumbai; web app on Cloudflare Workers (OpenNext); email intake option B (Gmail auto-forward → Cloudflare Email Routing → Email Worker). Evidence storage (P3) still open.

## Components

```
            Insurers
               │ email
               ▼
     Shared Gmail inbox ──(push / forward)──► Intake service
                                               │  classify, OCR, AI extraction,
                                               │  duplicate matching
                                               ▼
  Web app (office, orchestrator, admin) ◄──► Database + Auth + Storage ◄──► Field app (Android)
               │                                (row-level security)          offline capture,
               │ report + annexures                                           GPS / hash stamping
               ▼
     Insurer (email thread / portal pack)
```

## Proposed technology

| Layer | Proposal | Rationale |
|---|---|---|
| Database, auth, storage | Supabase (PostgreSQL, Auth, Storage, RLS), Mumbai region | Fast for a solo build; access control in the database; Indian hosting |
| Web app | Next.js | Office, orchestrator and admin screens |
| Field app | React Native (Expo), Android only | Offline storage, camera/GPS control, background upload |
| Intake service | Supabase Edge Functions or a small worker | Email ingestion, OCR, extraction, notifications |
| Extraction | LLM with structured (JSON-schema) output + OCR for scans | Handles varied insurer formats without per-insurer rules |
| Bulk evidence storage | Supabase Storage or Cloudflare R2 | R2 has no egress fees — relevant as office staff view evidence repeatedly |

## Planned repository layout

```
apps/web/            Next.js web application
apps/field/          Expo field app (Android)
services/intake/     Email ingestion and extraction
supabase/migrations/ Database migrations
docs/                Documentation
```

## Email intake options

The choice depends on whether the shared inbox is **Google Workspace** or a plain **@gmail.com** account.

| Option | Use when | Notes |
|---|---|---|
| A. Gmail API + push notifications | Google Workspace | Near real time; can label/archive processed mail; internal app avoids Google verification |
| B. Gmail filter → auto-forward to an inbound address | Plain @gmail.com, or fastest setup | No OAuth; e.g. Cloudflare Email Routing → Worker, or an inbound-parse service; original email and attachments preserved |
| C. IMAP with app password | Fallback | Polling; less robust |

**Recommendation:** A for Workspace; otherwise B. Full Gmail API access on a consumer account requires Google's restricted-scope security assessment, which is disproportionate for this project.

## Intake pipeline

1. Receive message → store raw `.eml` and attachments → insert `emails` row (idempotent on `gmail_message_id`).
2. Identify insurer by sender domain (`insurers.sender_domains`).
3. Classify: new case / reminder / additional documents / query.
4. OCR scanned attachments → `email_attachments.ocr_text`.
5. Extract fields with confidence → `intake_extractions` (`pending_review`).
6. Match to an existing case by `(insurer, claim no.)` or policy no.
7. Staff confirm on the review screen → `cases` row created; extraction marked `confirmed`.

## Field evidence pipeline

1. Capture in-app → compress (target 0.5–1 MB per photo) → compute SHA-256 on device.
2. Queue locally with GPS, accuracy, device time and device info.
3. Upload to storage via signed URL when online.
4. Insert `evidence` row; database sets `server_received_at`, auto-flags gallery uploads on camera-only items, and rejects duplicate hashes per case.

## Storage sizing

~300 cases/month × 30–50 items → **~15–25 GB/month**, ~200–300 GB/year. Apply on-device compression and an agreed retention/archive policy.

## Security

- Row-level security on every table; field users limited to cases on which they hold a task.
- Service-role keys used only in server-side services, never in client apps.
- Evidence immutable at database level; full audit log.
- Signed, time-limited URLs for all file access.
