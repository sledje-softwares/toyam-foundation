# `report-generate` — report versions as PDF / Word, and the HTML preview (7.7, D51)

> **Not used by the web app any more (7.7 piece 3).** The workspace builds the PDF (pdfmake) and the
> Word file in the office user's browser (`apps/web/lib/report-build`, `docs/13-report-layouts.md`
> "Built in the browser") and calls the same RPCs and storage policies with the user's own session.
> This function stays deployable until the browser path is confirmed (piece 4 retires it). Photo
> choice, byte budget, ordering and the placed-photo list are shared with the browser through
> `_shared/report/assemble.ts` (`planReportPhotos`, `loadReportPhotos`, `reportDataFrom`,
> `placedPhotoKeys`, `placedPhotoRecords`, `preparedProblem`).

The web app (server side, piece F) calls this with the signed-in staff user's own session from the
report workspace: **Preview** shows the HTML in a sandboxed iframe, **Generate report** makes a new
version. The database decides who may do it: `prepare_report_version` and `create_report_version`
refuse non-staff, cases the caller does not manage (D44) and cases outside the editable statuses
(D45, D46). Layout format and writers: `docs/13-report-layouts.md`; prepare / create contract:
`docs/12-office-pages/reports.md` "Generating a version".

```
POST /functions/v1/report-generate
Authorization: Bearer <signed-in staff user's access token>      (verify_jwt = true)
{ "case_id": uuid,
  "mode":    "generate" | "preview",          default "generate"
  "notes":   text | null }                    generate only; trimmed, ≤ 2000 characters
```

## Order of work (all database and Storage calls with the caller's JWT, no service-role key)

1. Session: `auth.getUser(token)`; otherwise 401.
2. Rate limit per user (in memory, per isolate): **generate** 1 per 15 s and 10 per hour,
   **preview** 20 per minute. Best effort against double clicks and runaway scripts.
3. `rpc prepare_report_version(p_case_id)`: header facts, layout, sections + values, `values_token`,
   default photo selection. A template version without `report_layout` → 422 `no_layout` (no
   fallback layout for real reports); an invalid stored layout → 422 `invalid_layout`.
4. Photos of the sections that the layout's `photos` blocks show (others are not fetched), in the
   order prepare returned them, 6 at a time:
   - **generate**: the phone's 1600 px copy (`derivatives`, R2 `derived/{case}/{sha}/w1600.jpg`),
     else the original; **preview**: the 384 px copy, then the 1600 px copy, then the original.
   - Originals are used as they are (insurer attachments are small JPEGs): only JPEG / PNG (the
     bytes are sniffed; the recorded type must not say otherwise), at most **3 MB** each. HEIC /
     WebP / other types without a copy, larger files, failed fetches and non-image bytes get
     `image: null`: the writers draw a dashed box "Photo not available: caption", and the reply
     carries a warning. Images are never decoded or re-encoded.
   - **Aadhaar (D55)**: the `evidence_ocr` rows (page 1) of the planned photos are read with the
     caller's client (`Gateway.loadOcr`). This function has no canvas, so it cannot black out a
     number: a photo whose OCR shows an Aadhaar-like number gets `image: null` (placeholder box) and
     a warning starting `Aadhaar masking: `; an ID-category photo with no number found is placed
     with a warning. The browser path masks instead (`docs/13-report-layouts.md` "Aadhaar masking at
     report time"). OCR rows that cannot be read: one warning, photos are placed.
   - Byte budget per report: **24 MB** of images for generate (Browser Rendering's body limit is
     50 MB and base64 adds a third), 12 MB for a preview; photos past it become placeholders with a
     warning. The budget counts the recorded size of the first choice.
   - R2 objects are read with the read-only R2 token (presigned GET, 60 s, server side), only for
     the keys prepare returned to this caller; Storage originals (`storage_backend = 'supabase'`,
     bucket `email-raw`) are downloaded with the caller's client, so the storage policies apply.
5. The layout is bound once (`bindReport`) for both writers.
   - **preview**: `htmlFromDocument(doc, 'preview')` → reply. Nothing is rendered, stored or
     recorded; Browser Rendering is not needed.
   - **generate**: new `report_id` (`crypto.randomUUID()`), then for the template's
     `output_formats` only: PDF via Browser Rendering (below), DOCX via `docxFromDocument`.
6. SHA-256 and size of each file; upload to bucket `reports` at
   `{case_id}/{report_id}/report.{pdf|docx}` with the caller's client, **no upsert**.
7. `rpc create_report_version(p_case_id, p_report_id, p_values_token, p_files, p_photos, p_notes)`.
   `p_photos` lists the photos **actually placed** in the document (image embedded; placeholders and
   photos of sections the layout does not show are left out) with the `section_key`, `position` and
   `caption` from prepare.

### Browser Rendering request

Cloudflare Browser Rendering REST API, `/pdf` endpoint
(<https://developers.cloudflare.com/api/resources/browser_rendering/subresources/pdf/methods/create/>,
<https://developers.cloudflare.com/browser-rendering/rest-api/pdf-endpoint/>):

```
POST https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/browser-rendering/pdf?cacheTTL=0
Authorization: Bearer {CF_BROWSER_RENDERING_TOKEN}
Content-Type: application/json
{ "html": "<!doctype html>…", "pdfOptions": { width, height, margin, printBackground, preferCSSPageSize,
  displayHeaderFooter, headerTemplate, footerTemplate },            ← exactly what renderReportHtml returns
  "setJavaScriptEnabled": false, "gotoOptions": { "waitUntil": "load", "timeout": 60000 } }
→ 200 application/pdf bytes   ·   errors {success:false, errors:[{code, message}]}
```

`cacheTTL=0` keeps the rendered report (personal data) out of Cloudflare's response cache (default
5 s). The reply must start with `%PDF-`, otherwise 502. Timeout 90 s (Cloudflare closes the browser
after 60 s). No retry loop: a 429 is passed straight back.

- **Free plan**: 1 request per 10 s per account and 10 browser-minutes per day. The function keeps
  its own spacing per isolate (`CF_BROWSER_MIN_INTERVAL_S`, default 10; set `0` on Workers Paid) and
  answers 429 before fetching any image.
- Cloudflare 429 → our 429 `rate_limited` with `retry_after` = its `Retry-After` (default 10 s).
  "Browser time limit exceeded for today" → `retry_after` = seconds to 00:00 UTC (05:30 India time);
  the message suggests trying later.

## Reply 200

```json
// preview
{ "ok": true, "html": "<!doctype html>…", "warnings": ["Photo \"Front view\" (Garage visit): HEIC images cannot be placed in a report; an empty box with the caption is printed instead."] }
// generate
{ "ok": true, "report_id": "uuid", "version": 3, "photos": 12,
  "files": [ { "format": "pdf",  "storage_path": "{case_id}/{report_id}/report.pdf",  "size_bytes": 812345, "sha256": "…" },
             { "format": "docx", "storage_path": "{case_id}/{report_id}/report.docx", "size_bytes": 790001, "sha256": "…" } ],
  "warnings": [] }
```

The preview HTML carries `Content-Security-Policy: default-src 'none'; img-src data:; style-src
'unsafe-inline'` and only `data:` images: show it in an `<iframe sandbox srcdoc>` (no
`allow-scripts`). `warnings` are for the user (unusable photos, a missing runtime asset such as the
seal, a field in the layout that the template lacks). `version` is the recorded one; if another
version was recorded at the same moment, a warning says the printed number differs.

## Errors `{ok:false, error:{code, message, field?, retry_after?, issues?}}`

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_body`, `invalid_input` (+ `field`) | not JSON, bad `case_id` / `mode` / `notes` |
| 401 | `unauthorized` | no / invalid session, expired JWT |
| 403 | `forbidden` | `42501`: not staff, not the case owner (D44), or the `reports` upload refused |
| 404 | `not_found` | `P0002`: no such case |
| 405 | `method_not_allowed` | not POST |
| 409 | `not_editable` | `55000`: case status does not allow a new version; message from the database |
| 409 | `values_changed` | `RV409`: "Someone changed the report while it was generating. Generate it again." |
| 422 | `no_layout` | template version without `report_layout` |
| 422 | `invalid_layout` (+ `issues`, ≤ 10) | stored layout fails validation |
| 422 | `invalid_case` | `22023` from prepare / create (e.g. case without a template, bad input) |
| 422 | `no_formats` | template lists neither pdf nor docx |
| 429 | `rate_limited` (+ `retry_after`, `Retry-After` header) | our per-user limit, our PDF spacing, or Browser Rendering's 429 |
| 502 | `pdf_failed` | Browser Rendering error other than 429, timeout, reply not a PDF |
| 502 | `upload_failed` | `reports` upload failed (not 401 / 403) |
| 502 | `upstream_error` | prepare / create failed otherwise |
| 503 | `storage_not_configured` | a phone photo is needed and the R2 read secrets are not set |
| 503 | `pdf_not_configured` | the template outputs PDF and the Browser Rendering secrets are not set |
| 500 | `internal` | unexpected |

**Files uploaded but no version recorded** (`values_changed`, `not_editable` raised by create, an
upstream error): the uploaded objects are left in `reports`. They cannot be overwritten (no update
policy for generated paths), nothing references them, and the next attempt uses a new `report_id`.
They are orphans of a few hundred kB; a later clean-up job may delete `reports` objects under
`{case_id}/{report_id}/` that have no `report_files` row (none exists yet; staff cannot delete).

## Limits and CPU

Edge limits: 2 s CPU per request (async I/O excluded), 150 s wall, 256 MB memory. No image is
decoded; base64 is table-driven (`_shared/report/image.ts`). Measured in
`services/intake/test/report-generate-cpu.test.ts` (30 photos × 500 kB, PDF 15 MB, Node 22 on a
loaded 4-core dev machine, warm run): bind 1 ms, HTML + base64 ~200 ms, `/pdf` JSON body ~150–200 ms,
DOCX (STORE zip + CRC-32) ~95 ms, SHA-256 of the 15 MB PDF ~95 ms and of the DOCX ~75 ms; the whole
request ~460–640 ms. Memory at that size: images 15 MB, HTML 20 MB, JSON body 20 MB + its UTF-8
copy, PDF and DOCX ~15 MB each.

## Secrets

- `CF_ACCOUNT_ID`, `CF_BROWSER_RENDERING_TOKEN`: an account API token with the Browser Rendering write
  permission only ("Browser Rendering – Edit"; Cloudflare's newer docs call the product Browser Run). Never logged. Optional `CF_BROWSER_MIN_INTERVAL_S` (default `10`; `0` on Workers Paid).
- `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_READ_ACCESS_KEY_ID`, `R2_READ_SECRET_ACCESS_KEY` (shared with
  `evidence-view`; falls back to `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` like it).
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` come from the platform.

Logs carry codes, statuses and ids only (no tokens, signed URLs, values or captions).

```
npx -y supabase@3.1.0 secrets set CF_ACCOUNT_ID=… CF_BROWSER_RENDERING_TOKEN=…   # R2 read secrets as for evidence-view
npx -y supabase@3.1.0 db push --linked --yes                                    # 20261117000000_report_versions, 20261117400000_template_report_layout
npx -y supabase@3.1.0 functions deploy report-generate --use-api --yes
```

## Tests

`services/intake/test/report-generate.test.ts` (fake gateway: happy path, preview, photo fallbacks,
HEIC, byte budget, formats, 429, RV409, error mapping, limits, configuration) and
`report-generate-cpu.test.ts` (CPU numbers above; fails above 1.5 s).

## To confirm against the real services

- Browser Rendering accepts `pdfOptions.width` / `height` / `margin` as `"210mm"` strings (Puppeteer
  does) and renders `headerTemplate` / `footerTemplate` with `pageNumber` / `totalPages`.
- The free plan's 429 carries `Retry-After`, and the daily-limit wording still contains "time limit".
- How long a 20 MB HTML body takes to render (wall time and browser-minutes against the 10 / day).
- Storage `upload` of an existing path without upsert answers 409/400, not an overwrite (the policy
  forbids update anyway).
