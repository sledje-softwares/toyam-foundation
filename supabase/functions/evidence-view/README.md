# `evidence-view` — short-lived view / download links (gap G3)

The web app (`apps/web/lib/evidence-view.ts`, server side) calls this with the signed-in user's own
session to show evidence thumbnails, open files and download insurer attachments. Any signed-in
user may call it; what they get is decided by RLS, so a field operator only gets links for files
posted into their own threads (rule 4) and an office user only for the cases RLS lets them read
(D44). Files are never public: every link expires.

```
POST /functions/v1/evidence-view
Authorization: Bearer <signed-in user's access token>      (verify_jwt = true)
{ "evidence_ids":   [uuid, …],                  evidence rows (field files on R2, insurer attachments in Storage)
  "attachment_ids": [uuid, …],                  email_attachments rows (intake review, before a case exists)
  "disposition":    "inline" | "attachment" }   default "inline"
```

1–50 ids in total; repeated ids are answered once. Both lists are optional, but at least one id is
needed.

Order of work, all **with the caller's JWT** (no service-role key):

1. Session: `auth.getUser(token)`; otherwise 401.
2. Rate limit per user (in memory, per isolate, sliding minute): 60 calls and 1 000 ids. Best effort
   against a runaway page or script; not a global quota.
3. `select … from evidence where id in (…)` and `select … from email_attachments where id in (…)`
   through PostgREST: RLS decides. An id that is missing **or** not visible comes back as
   `not_found` — the reply never tells the two apart.
4. For each visible row with a file:
   - `storage_backend = 'r2'`: a presigned **GET** for the object key (checked against
     `cases/{case_id}/(tasks/{task_id}|files)/{sha256}.{ext}`), valid 300 s, with signed
     `response-content-type` (the database's mime type) and `response-content-disposition` overrides.
   - `storage_backend = 'supabase'` and attachments (bucket `email-raw`): `createSignedUrl(path, 300)`
     made with the caller's client, so the `email_raw_staff_select` storage policy applies too.
     For a download, Storage sets `Content-Disposition: attachment` with the file name.
5. `inline` is honoured only for types a browser can show safely (the evidence-upload allow-list
   of images, PDF, audio and video, plus `image/gif` and `text/plain`). HTML, SVG, XML, Office files
   and everything else are always served as `attachment`, so a stored file never runs in a page.

## Reply 200

```json
{ "ok": true, "expires_in": 300,
  "files": [
    { "kind": "evidence", "id": "…", "url": "https://<account>.r2.cloudflarestorage.com/<bucket>/cases/…?X-Amz-…",
      "expires_at": "2026-11-15T12:05:00.000Z", "content_type": "image/jpeg", "file_name": "IMG_0001.jpg",
      "disposition": "inline" },
    { "kind": "attachment", "id": "…", "url": "https://<project>.supabase.co/storage/v1/object/sign/email-raw/…?token=…",
      "expires_at": "…", "content_type": "text/html", "file_name": "page.html", "disposition": "attachment" },
    { "kind": "evidence", "id": "…", "error": "not_found" } ] }
```

`files` keeps the request order (evidence ids first, then attachment ids). Per-file `error`:

| `error` | Meaning |
|---|---|
| `not_found` | No such row, or the caller cannot see it (RLS). |
| `no_file` | A note: there is nothing to open. |
| `archived` | The cloud copy was purged after a verified archive (D13); ask an admin for the archive copy. |
| `unavailable` | The row is visible but no link could be made (Storage refused the caller, or the stored key is malformed). Logged. |

Links are not cached by the caller across requests: request new ones when a page renders, or use
the web app's `/files/{evidence|attachment}/{id}` redirect, which asks for a fresh link each time.

## Errors `{ok:false, error:{code, message, field?}}`

| Status | `code` |
|---|---|
| 400 | `invalid_body`, `invalid_input` (+ `field`) |
| 401 | `unauthorized` (no / invalid session, expired JWT) |
| 405 | `method_not_allowed` |
| 429 | `rate_limited` (+ `Retry-After` header) |
| 502 | `upstream_error` (a select failed) |
| 503 | `storage_not_configured` (a visible R2 file was asked for and the R2 secrets are not set; Storage-only requests still work) |

## Secrets

- `R2_ACCOUNT_ID`, `R2_BUCKET` (shared with `evidence-upload` / `field-drain`).
- `R2_READ_ACCESS_KEY_ID`, `R2_READ_SECRET_ACCESS_KEY`: an R2 API token limited to **object read** on
  the evidence bucket (least privilege). If they are not set, the shared `R2_ACCESS_KEY_ID` /
  `R2_SECRET_ACCESS_KEY` pair is used, which then also needs read.
- `PUBLIC_SUPABASE_URL` (optional, local dev): the edge runtime's `SUPABASE_URL` is internal
  (`http://kong:8000`) on the local stack; with this set, Storage links are rewritten to that origin
  (e.g. `http://127.0.0.1:54321`). Not needed on the hosted project.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` come from the platform.

The R2 secret only signs; it is never returned or logged. Logs carry codes and ids only.

```
npx -y supabase@3.1.0 secrets set R2_READ_ACCESS_KEY_ID=… R2_READ_SECRET_ACCESS_KEY=…   # plus R2_ACCOUNT_ID / R2_BUCKET if not set yet
npx -y supabase@3.1.0 functions deploy evidence-view --use-api --yes
```

## Tests

- Logic and flow: `services/intake/test/evidence-view.test.ts` (fake gateway; presigned GET).
- Web wrapper: `apps/web/lib/evidence-view-core.test.ts`.

## To confirm against the real bucket

- R2 honours the signed `response-content-type` / `response-content-disposition` overrides on a
  presigned GET (S3 does; check with `curl -I`).
- `<img src>` of a presigned R2 URL needs no bucket CORS; a `fetch()` from the browser would.
