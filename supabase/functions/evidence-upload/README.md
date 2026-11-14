# `evidence-upload` — presigned R2 PUTs for signed-in users (build plan 1.4)

The field app's outbox (`apps/field/src/outbox`, `evidenceUploadPresigner`) calls this before it PUTs
each file to R2, then posts the files with `post_thread_message()`. Deactivated operators use
`field-drain` `presign` instead (D43). Both sign with `_shared/r2/presign.ts`.

```
POST /functions/v1/evidence-upload
Authorization: Bearer <signed-in user's access token>      (verify_jwt = true)
{ "task_id": uuid, "case_id": uuid,
  "files": [ { "sha256": 64 lower-case hex, "size": bytes, "mime": "image/jpeg", "device_captured_at": ISO 8601 } ] }   1–30 files
```

Order of checks, all made **with the caller's JWT** (no service-role key, rule 4):

1. Session: `auth.getUser(token)`; otherwise 401.
2. `can_upload_evidence_at(task_id, device_captured_at)` for each distinct capture time: the open-task
   rule, or the D43 late-upload window. Any `false` → 403 `upload_window_closed`, nothing signed.
3. `evidence_upload_target(task_id, sha256[])` (migration `20261114500000_evidence_upload.sql`): the
   task's case (must equal `case_id`, else 400) and which hashes that case already stores.
4. For each new file, a PUT URL for `cases/{case_id}/tasks/{task_id}/{sha256}.{ext}` (the key scheme of
   docs/05 and field-drain), valid 600 s, with `x-amz-content-sha256` (= the file's hash, also the
   canonical payload hash) and `content-length` (= `size`) as signed headers. The extension comes from
   the mime type, not from the client.

## Reply 200

```json
{ "ok": true, "case_id": "…",
  "files": [
    { "sha256": "…", "status": "upload", "storage_path": "cases/…/tasks/…/….jpg", "method": "PUT",
      "url": "https://<account>.r2.cloudflarestorage.com/<bucket>/cases/…", "headers": { "x-amz-content-sha256": "…" },
      "expires_in": 600 },
    { "sha256": "…", "status": "already_stored", "storage_path": "cases/…/tasks/…/….pdf" } ] }
```

- PUT the file body to `url` with exactly `headers`; the HTTP client sets `Content-Length` from the file.
- `already_stored`: the case already holds this hash (rule 6). Skip the PUT; post the file as usual with
  `storage_path`. `post_thread_message()` skips a file already stored on the case (no 23505), like the
  late / drain path, and still stores the message.

## Errors `{ok:false, error:{code, message, field?}}`

| Status | `code` | Outbox class |
|---|---|---|
| 400 | `invalid_body`, `invalid_input`, `unsupported_type` | rejected (held for the office) |
| 401 | `unauthorized` (no / invalid session, expired JWT) | auth |
| 403 | `upload_window_closed` (+ `refused: [sha256]`) | window_closed (split / held, D43) |
| 403 | `forbidden` (no access to the task) | rejected |
| 413 | `file_too_large` | rejected |
| 502 | `upstream_error` (database call failed) | transient |
| 503 | `storage_not_configured` | transient |
| 405 | `method_not_allowed` | — |

## Types and size caps

| Family | Types (extension) | Max |
|---|---|---|
| image | jpeg (jpg), png, webp, heic, heif | 20 MB |
| application | pdf | 25 MB |
| audio | mp4 (m4a), aac, mpeg (mp3), ogg, opus, amr, 3gpp (3gp), webm | 50 MB |
| video | mp4, 3gpp (3gp), quicktime (mov), webm | 300 MB |

Camera photos are compressed to ~0.5–1 MB on the phone (docs/11); the caps are for gallery and shared
files. Change them in `_shared/evidence-upload/logic.ts` (`MIME_EXT`, `MAX_BYTES`).

## Secrets

Same as `field-drain`: `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (an R2 API
token limited to object write on the evidence bucket). `SUPABASE_URL` and `SUPABASE_ANON_KEY` come from
the platform. The R2 secret only signs; it is never returned or logged. Logs carry codes and ids only.

```
npx -y supabase@3.1.0 secrets set R2_ACCOUNT_ID=… R2_BUCKET=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=…
```

## Tests

- Logic and flow: `services/intake/test/evidence-upload.test.ts` (fake gateway).
- Database: `supabase/tests/14_evidence_upload.test.sql`.
- App side: `apps/field/src/outbox/server.test.ts`, `outbox.test.ts`.

## To confirm against the real bucket

- R2 enforces the signed `content-length` and refuses a body whose SHA-256 differs from
  `x-amz-content-sha256` (S3 does both; check R2 with a wrong-size and a wrong-hash PUT).
- expo-file-system `uploadAsync` (OkHttp) sends `Content-Length` for a file body with
  `BINARY_CONTENT` and passes `x-amz-content-sha256` through unchanged.
- R2 bucket CORS is not needed (native client), but the token must allow `PutObject` on the bucket.
