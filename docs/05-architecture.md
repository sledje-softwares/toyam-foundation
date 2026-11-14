# 05 — Architecture (Phase 1, revised 2026-11-13)

Status: **confirmed** — D10–D13 (Supabase Mumbai on free tiers, web app on Cloudflare Workers via OpenNext, Cloudflare-based intake, R2 for evidence with daily local archive) and D14–D26 (revised workflow).

## Components

```
 Insurers ──email──► Shared Gmail ──filter: forward insurer mail──► Email Routing ──► Cloudflare Worker email()
                          └──────── hourly IMAP safety net (insurer senders) ──────────► (same Worker, scheduled())
                                                              │ raw message
                                                              ▼
                                           Supabase Edge Function "intake"
                                           parse → detect insurer/template → fill fields
                                           → case (auto) or review queue → evidence from attachments
                                                              │
 ┌────────────────────────────── Supabase (Postgres + Auth + Storage, RLS) ─────────────────────────────┐
 │ cases · case_field_values · tasks · case_messages · evidence · evidence_ocr/labels · processing_jobs │
 │ case_templates · assignment_rules · reports · report_approvals · submissions · notifications · audit │
 └──────▲───────────────────────▲─────────────────────────────▲─────────────────────────▲──────────────┘
        │                       │                             │                         │
  Web app (Next.js on      Field app (Expo, Android)     Pipeline worker(s)       Sender (Edge Function)
  Cloudflare Workers)      chat threads, camera,         claim jobs: text layer,  report → PDF/Word →
  office · orchestrator    gallery, share target,        OCR fallback, labels,    Gmail SMTP reply on
  · admin                  offline queue, device OCR     suggestions              the insurer thread
        │                       │
        └──── presigned PUT/GET (server function checks can_upload_*) ────► Cloudflare R2 (evidence files)
                                                                             ▼ daily
                                                                    Admin PC archive (D13)
```

## Technology

| Layer | Choice | Notes |
|---|---|---|
| Database, auth, storage | Supabase, `ap-south-1`, free tier during build (D10) | Paid plan decision before go-live (P5) |
| Web app | Next.js on Cloudflare Workers (OpenNext) (D11) | `apps/web` |
| Field app | React Native (Expo), Android only | Custom dev build needed for the share target and ML Kit |
| Intake relay | Cloudflare Worker: `email()` push via Email Routing (D33) + hourly IMAP safety net (app password) | Relays only; push needs DNS for a subdomain of the firm's domain (Q14) |
| Intake parser | Supabase Edge Function | Rule-based per template; AI fallback only (D26) |
| Evidence files | Cloudflare R2, key `cases/{case}/tasks/{task}/{sha256}.{ext}` or `cases/{case}/files/{sha256}.{ext}` | No egress fees |
| On-device OCR | Google ML Kit text recognition (Latin + Devanagari) | Free; result sent with the file |
| Image labelling and field matching | Small vision model behind one adapter (`services/labeller`): API (Haiku / Gemini Flash-Lite / GPT nano class) or open-weight Qwen3-VL on a GPU; chosen by bake-off (D34). One call per image returns labels, matched report fields and an optional description (D35) | One image per call at ~384 px with a cached per-template prompt; ≈ $7–15 a month at 90k images; data-sharing approval Q21 |
| Server OCR | Dedicated open-source OCR model (PaddleOCR family) on a fixed-cost CPU worker | After labelling, only where `ocr_wanted()` (D34) |
| Push | Firebase Cloud Messaging | Free |
| Report generation | Word template filling (insurer layout) + PDF conversion | Output option per template (D22) |
| Report sending | Gmail SMTP with app password, reply headers of the original thread | Free; appears in the shared Sent folder |

## Repository layout

```
apps/web/              Next.js web application
apps/field/            Expo field app (to be created, M5)
services/intake/       Gmail relay Worker, template loader, intake tests (parser in supabase/functions/_shared/intake)
services/pipeline/     Processing worker: one container (D38) (to be created, M6)
config/templates/      Evidence categories and case templates (YAML)
supabase/migrations/   Database migrations
supabase/tests/        pgTAP tests
docs/                  Documentation
```

## Intake pipeline (M3) — built; runbook in `services/intake/README.md`

1. Gmail forwards insurer mail to the Email Routing address; the Worker's `email()` handler checks the envelope sender (shared Gmail) and posts the raw message to the `intake` function. Hourly, the Worker also polls the inbox over IMAP (insurer senders only) for anything forwarding missed; the function drops known Message-IDs before storing anything.
2. Store raw `.eml` and attachments (`email-raw`); insert `emails` (idempotent on the message id); hash attachments.
3. Sender from the firm's own addresses → internal; attach to the case thread history only (Q15).
4. Insurer by sender domain; template by `intake_rules.subject_pattern` (variant, claim no.).
5. Existing case (same insurer + claim no., or same Gmail thread) → classify as follow-up / reminder / documents / query and attach.
6. New case: parse the label/value table and the investigation-points block using each field's `extract` rules.
7. All required intake fields found → create the case with `template_id` and `case_field_values` (source `email_parser`); else (or AI fallback used) → `intake_extractions` review queue (D26).
8. Insert attachments as case evidence (`capture_source = email_attachment`) → processing jobs → file-name labels.
9. Case insert triggers automatic assignment (M4).

## Field thread pipeline (M5)

1. Capture (camera) or pick (gallery / document / share target) → compress → SHA-256 → device OCR for photos of documents.
2. Queue locally with a `client_message_id`; show 🕓.
3. Online: get presigned R2 URL (`can_upload_evidence(task)`), upload, then call `post_thread_message()` — idempotent, so a retry never duplicates (✓).
4. The database stores message + evidence (server time), operator tag, device OCR, and enqueues processing (✓✓ when done; blue when office staff have read the thread — `case_thread_state()`).

## Processing pipeline (M6)

See `10-processing-pipeline.md`. **Hosting (D38):** one small always-on container in a Mumbai region runs `services/pipeline` (label stage with Haiku → Sonnet escalation per D37, PaddleOCR, field-value rules); Dockerfile shipped, no provider-specific code; the service-role key is held server-side only. Workers call `claim_processing_jobs()` / `complete_processing_job()` with the service role; stages run in order per file.

## Report pipeline (M7–M8)

1. Section form reads the template; intake values pre-filled; each section shows evidence whose active labels match its categories.
2. Tap an OCR block to fill the focused field; accepted values keep `source_evidence_id` and the block reference.
3. Generate → `reports` (version) + `report_files` (pdf / docx) + `report_annexures`.
4. Approval where the template requires it → send as a reply on the insurer thread in the chosen formats → `submissions`.

## Storage sizing

~300 cases/month, ~50–60 images per case after compression (≈0.5 MB) plus documents → **~20–30 GB/month** on R2 until purged after archive (D13).

## Security

- Row-level security on every table; field users only see cases on which they hold a task, and only files posted into those threads.
- Service-role key only in server-side functions and workers; client apps use the publishable key.
- Evidence rows immutable; withdraw hides, never deletes; full audit log.
- Presigned, short-lived URLs for all file access.
