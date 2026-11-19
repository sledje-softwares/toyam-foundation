# 11 — Field App (M5, D17–D19)

Android app for field operators. It should feel like the chat app they already use every day — same interaction patterns, own name and branding — so that sending a photo to a case is as quick as sending it to an office WhatsApp group.

## Screens

```
┌ My cases                   ⋮ ┐   ┌ ← INV-2026-000123 · Ravi S ────┐
│ ⋮ menu ▸ Outbox (2)          │   │ ⋮ menu ▸ Checklist (5/9)        │  menu options (D41)
│        ▸ Sign out            │   │        ▸ Mark task done         │  complete_field_task
│ [ Open (3) ]  Completed      │   │                                 │
│                              │   │ ─────────────────────────────── │
│ ● INV-…123  Ravi S      2:14 │   │ ⚙ Field work assigned to you:   │  system event
│   Please collect the DL …  ②│   │   Visit garage and spot          │
│   INV-…118  Sample Trd  11:02│   │ 🗨 Office: Please collect the DL │
│   📷 Photo                   │   │                 [img][img] ✓✓   │  own media + ticks
│   INV-…109  Mohan L     Mon  │   │              Reached garage ✓✓  │
│                              │   │ ⚠ Request: Get towing bill      │  re-investigation
│                              │   │ ─────────────────────────────── │
│                              │   │ 📎  📷  [ Message…        ] 🎤 │
└──────────────────────────────┘   └─────────────────────────────────┘
```

| Screen | Content | Data |
|---|---|---|
| Cases | Tabs **Open** (has an open task) / **Completed**; last message preview, time, unread badge; search by name / claim no. / vehicle. Header **⋮** menu (same style as the thread's): **Outbox** ("Outbox (N)" while files wait; always listed) and **Sign out** (2026-11-19: moved off the bottom of the list; the sign-out check of spec 9 is unchanged). The "Outbox (N)" row above the tabs stays while files wait | `field_case_list()`; menu entries `src/ui-logic/caseListMenu.ts` |
| Thread | Case header (insured, vehicle, location, insurer points), pinned checklist, messages incl. system events and requests, composer | `case_messages`, `case_field_values` (intake only), `v_case_checklist` |
| Camera | In-app camera, burst, document mode (edge crop) | local |
| Picker | Gallery and documents, multi-select | local |
| Share target | "Share → Toyam" from any app → choose case (Open first) → optional caption and tag → send | Android intent `ACTION_SEND` / `ACTION_SEND_MULTIPLE` for `image/*`, `video/*`, `application/pdf`, `audio/*` |
| Checklist | Opened from the thread's menu (D41); items with progress; **ticks itself once a file is labelled and matched** (D30, D35); tap an item to capture directly into it | `task_checklist_items`, `v_case_checklist`, `evidence_labels` (realtime) |
| Outbox | Files saved on this phone, per case, progress, "Send now", last try (D43, spec 3) | local queue; `report_outbox_status()` |
| Mark task done | Thread menu (⋮). See "Mark task done" below | `tasks` (own open tasks), `complete_field_task()` |

## Sending

1. Operator captures or selects files; optional caption; optional one-tap category chip (from the checklist's categories).
2. App compresses photos (~0.5–1 MB), computes SHA-256, reads GPS (camera only), keeps EXIF. In the background it makes the 1600 px / 384 px copies (D51) and reads the text of every photo from the 1600 px copy with ML Kit (see "Device OCR and description").
3. Message is stored locally (app sandbox) with a new `client_message_id` → shown with 🕓.
4. When online (WorkManager job): presigned upload to R2 for each file (edge function `evidence-upload`, contract in its README: checks `can_upload_evidence_at(task, device_captured_at)` with the operator's JWT; PUT bound to `x-amz-content-sha256` and the file size; `already_stored` skips the PUT), then `post_thread_message()` with the items. Retries reuse the same `client_message_id`, so nothing is duplicated; a file already stored is skipped.

Gallery and shared files are accepted exactly like camera captures — no mark, no block (D18). The origin is kept internally in `capture_source`.

## Ticks

| Tick | Meaning | Source |
|---|---|---|
| 🕓 | Saved on this phone, sends by itself (never "Failed"; tap → explanation sheet, see Offline experience 2) | local queue |
| ✓ | Stored on the server | message row exists |
| ✓✓ | Processed (read and labelled) | `v_evidence_processing.state = done` for all files |
| blue ✓✓ | Seen by office | `case_thread_state().staff_last_read_at ≥ message time` |

## Offline experience (D43)

Principle: the phone is a safe place for files. Nothing the operator captured is lost or shown as failed; the app sends by itself and tells the operator calmly what is still on the phone.

### Behaviour

- **Storage.** Queued files live in the app sandbox (never the gallery) with their SHA-256, capture time (device clock), GPS and caption. The queue is a local database; the files are kept until the server has stored the message (✓).
- **Background upload.** One unique WorkManager job (`NetworkType.CONNECTED`, exponential backoff starting at 30 s, capped at 30 min) drains the queue. It survives reboot, app update and a killed app; while uploading it runs as a foreground service with a quiet progress notification ("Sending 3 of 12 files").
- **Silent retries.** No error dialogs, toasts or red marks for network or server errors. Only after **6 h** with files waiting and no successful send does the app show one gentle prompt (spec 7).
- **Cache for reading offline.** While online the app caches, per open case: case details (insured, vehicle, location), the checklist, insurer points and the last 200 thread messages. Each cached block stores the server time it was fetched.
- **Freshness.** Case header and checklist show "Updated … ago" from that time (spec 4).
- **Pending ticks.** A checklist item covered by a queued file (operator picked the item or a category chip) shows a hollow tick until the real tick arrives from labelling (D41).
- **Outbox report.** On every queue change (at most once a minute) and after each send, the app calls `report_outbox_status(device_id, pending_count, pending_bytes, oldest_pending_at)`; the office sees "Ravi: 12 files waiting on phone, last online 2 h ago" in the thread header (`case_outbox_status(case_id)`).
- **Late uploads.** If the task closed or was reassigned while files waited, the same `post_thread_message()` call still works for files whose capture time is within the operator's hold on the task, for 72 h after it ended. If the server answers `42501` with hint `upload_window_closed`, the app splits the message into one message per file (new `client_message_id` per file) so eligible files still go. Files that are still refused stay in the Outbox as "Waiting for the office" (spec 3); the office sees them in the outbox count and can raise a new task, after which they send normally.
- **Device registration.** At sign-in the app creates a `device_id` (UUID) and a 32-byte random secret (Android Keystore-backed encrypted storage), and calls `register_field_device(device_id, sha256_hex(secret_hex), 'android')`. The secret itself never leaves the phone until a drain. Sign-out (when allowed) discards both.

### User-facing spec (build from this; wording is exact)

1. **Amber offline bar.** Under the app bar on Cases and Thread while there is no connection. Amber background, dark text, no icon animation. Text: **"Offline · {N} files saved on this phone"** (N = queued files; when N = 0: **"Offline · you can keep working"**). When the connection returns and files start sending, the bar turns neutral for the duration of sending: **"Sending {k} of {N}…"**, then disappears. Tapping the bar opens the Outbox.
2. **🕓 explanation sheet.** Tapping a 🕓 on any message opens a bottom sheet. Title **"Saved on this phone"**. Body **"This will send by itself when you have signal. You can close the app or switch off the phone — nothing will be lost."** Line **"Last try: {time}"** (or **"Waiting for signal"** if never tried). Buttons **"Send now"** (primary) and **"Open Outbox"**.
3. **Outbox screen.** From the Cases menu (**"Outbox ({N})"**, hidden when empty) and from the bar/sheet. Title **"Outbox"**. Summary line **"{N} files · {size} saved on this phone"**. One card per case: case ref and insured name, **"{k} of {n} files sent"** with a progress bar, **"Last try: {time}"**, button **"Send now"**. Files refused by the late-upload rule show **"Waiting for the office — they can see these files"** instead of progress. Long-press a file → **"Remove from phone"** → confirmation dialog **"Remove this file? It has not been sent to the office and will be deleted from this phone."** with **"Keep"** (default) and **"Remove"**. Nothing is removed without that confirmation. Empty state: **"Everything is sent ✓"**.
4. **Freshness labels.** In the case header and at the top of the checklist: **"Updated just now"** (< 1 min), **"Updated {m} min ago"**, **"Updated {h} h ago"**, **"Updated {d} days ago"**. Grey; amber when older than 24 h. When there is no cache yet: **"Not downloaded yet — open this case once with signal"**.
5. **Hollow pending ticks.** A checklist item with a queued file shows a hollow tick ○✓ (outline only, grey) and the caption **"Sending…"** (online) or **"Saved on phone"** (offline). It becomes the normal filled tick only when the server ticks it after labelling (D41). It never shows a cross.
6. **"All N files sent ✓" notification.** A local notification when the queue becomes empty after at least one file was waiting more than 1 minute: title **"All {N} files sent ✓"**, body **"The office has them now."** Tapping opens the last case that sent. Not shown while the app is in the foreground on that thread (the ticks already show it).
7. **Gentle prompt after 6 h.** Once per 6-hour stretch with files waiting and no successful send: a local notification and, when the app is open, a non-blocking banner. Title **"{N} files are still on this phone"**. Body **"They will send by themselves when you have signal. If you are on Wi-Fi or mobile data now, tap to send."** Button **"Send now"**. Never says "failed" or "error".
8. **Low-storage warning.** When free phone storage drops below 500 MB (or the queue would push it below 200 MB): banner on Cases and in the camera **"Phone storage is almost full. Your {N} saved files are safe — connect to send them and free space."** Below 200 MB the camera shows a dialog before capture: **"Not enough space for more photos. Send saved files first, or free space on the phone."** with **"Open Outbox"** and **"OK"**. Never deletes queued files by itself.
9. **Sign-out blocked while files wait.** Menu (⋮ on "My cases") → Sign out with files queued opens **"{N} files are not sent yet"** / **"Signing out would delete them from this phone. Connect to the internet and wait for them to send."** with **"Open Outbox"** and **"Stay signed in"** only (no sign-out button). With an empty queue sign-out works as usual.
10. **Remote sign-out (operator deactivated): drain, then wipe.** When the session refresh fails because the account is blocked, the app calls `field-drain` `status`. If `state = 'drain'`: a full-screen, non-dismissable page **"Your access has been removed"** / **"Sending the {N} files you took before that. Keep the app open or connected — this finishes by itself."** with progress **"{k} of {N} sent"**. Cases and the camera are no longer reachable. When done (or if `state = 'closed'`, or after the 7-day window): **"All files sent. This phone is now signed out."** (if some could not be sent: **"{k} files were sent. {m} could not be sent and have been removed."**), then the app calls `finish`, wipes the cache, queue, device secret and session, and returns to the sign-in screen. If `state = 'active'` the account was restored: back to normal sign-in.

### Remote sign-out contract (`supabase/functions/field-drain`)

`POST /functions/v1/field-drain`, no `Authorization` (the user is banned; `verify_jwt = false`), JSON body with `device_id` and `secret` (64 lower-case hex) on every call. Errors: `{ok:false, error:{code,message}}` with 401 `device_unknown`, 409 `not_deactivated`, 410 `drain_window_closed` / `drain_finished`, 422 `upload_window_closed` (drop that file; count it as "could not be sent"), 400 `invalid_input`, 429 `rate_limited` / `device_locked` (see below), 5xx retry with backoff.

| `action` | Extra fields | Reply |
|---|---|---|
| `status` | — | `{state: 'drain' \| 'active' \| 'closed', deactivated_at, drain_until}` |
| `presign` | `task_id, sha256, ext, device_captured_at` | `{case_id, storage_path, method: 'PUT', url, headers: {'x-amz-content-sha256'}, expires_in: 600}` — PUT the file to `url` with those headers |
| `post` | `case_id, client_message_id, kind ('media' \| 'voice'), body?, task_id?, reply_to?, items[]` (same items as `post_thread_message`, each with `device_captured_at`) | `{message_id}`; a retry with the same `client_message_id` returns the same id, even after the window |
| `outbox` | `pending_count, pending_bytes, oldest_pending_at?` | `{}` |
| `finish` | `discarded_count?` | `{wipe: true}` — the device id is retired; wipe now |

**Rate limits (per `device_id`, server clock; migration `20261114600000_drain_rate_limit.sql`).** The function has no JWT, so every request first calls `drain_check()`: 5 failed secret checks within 15 minutes lock the device for 1 hour (even the right secret is refused; each lock is written to `audit_log` as `DRAIN_DEVICE_LOCKED`); at most 120 calls per minute; at most 500 presigned files per hour. Over a limit the reply is **429** with `error.code` `rate_limited` or `device_locked` and a `Retry-After` header in seconds. The app should treat 429 as "retry later" and back off by `Retry-After` (not the normal exponential step); a locked phone simply keeps its files and tries again after the hour. Limits live in `app_settings` (`drain_fail_limit`, `drain_fail_window_minutes`, `drain_lock_minutes`, `drain_calls_per_minute`, `drain_presigns_per_hour`).

Accepted only for files captured (device clock) before `profiles.deactivated_at`, within the operator's hold on the task, within 7 days of deactivation; text-only messages are not drained. Every presign and file is audited.

## Device OCR and description (gap 35)

User decision 2026-11-19: OCR runs **on the operator's phone** on the **1600 px copy** of every photo, and its text
is stored with the image together with a **short description** that applies to the original and both copies. No
generative model (the test phone is a low-end Galaxy F12): the description is built from the operator's tag and the
OCR text.

| Piece | Where |
|---|---|
| Native module (local Expo module, autolinked from `apps/field/modules`) | `modules/toyam-ocr` (Kotlin, `ToyamOcrModule.kt`): ML Kit text recognition v2 **16.0.1**, **bundled** Latin + Devanagari models (offline from the first launch, no Play-services download). Own low-priority thread: neither the UI thread nor the shared Expo module queue waits. |
| JS adapter | `src/ocr/native.ts` (`requireOptionalNativeModule('ToyamOcr')`; missing module = no OCR) |
| Block mapping, Latin + Devanagari merge | `src/ocr/blocks.ts` |
| Aadhaar masking | `src/ocr/mask.ts` (same rule in SQL: `private.mask_aadhaar`) |
| Description | `src/ocr/describe.ts` |
| Read step (best effort) | `src/ocr/read.ts` (`readPhoto`) |
| Outbox step (persist, send, retry) | `src/outbox/outbox.ts` (`startOcr`, `sendOcr`), tests `src/outbox/ocr.test.ts`, `src/ocr/ocr.test.ts` |
| Server call | `record_device_ocr()` (migration `20261119600000_device_ocr.sql`, docs/06) |

- **What is read:** camera, gallery and shared **images** (the ones that get copies). Not videos, audio or PDFs (a
  PDF's text layer is read on the server, `text_extract`). Both script models run on each photo; the Latin reading is
  the base and a Devanagari-model line containing Devanagari script replaces the Latin lines it overlaps.
- **When:** after the photo's copies are made, in the background, one photo at a time. Sending the message is not
  delayed (✓ as before); the copies of that photo wait until it is read (the 1600 px file must still exist), then the
  text goes. Order per photo: original PUT → `post_thread_message` → both copies → `record_device_ocr`.
- **Stored on the phone:** the result is kept on the file in the outbox store (`OutboxFile.ocr`, item JSON in SQLite),
  so it survives restarts and works offline; after a restart a photo whose 1600 px copy was not read yet is read then.
- **Best effort:** a failed read, a refusal (no longer on the case, withdrawn, bad input) or 6 failed sends drop the
  text silently; transient errors share the outbox backoff; an expired session pauses like for files. OCR never holds a
  message and is never shown to the operator (no ticks, counts or sign-out checks). Low storage: copies are not made, so
  nothing is read. Battery: one read is ~1–2 s of CPU on a low-end phone and only runs while the app (or its background
  job) runs; no separate battery check yet. Drain mode (remote sign-out): neither read nor sent.
- **Blocks:** one per text line, `{text, bbox:[x,y,w,h], conf, line}` in the **1600 px copy's pixels** (its size is
  `evidence_derivatives.pixel_width/height` for width 1600), reading order, `conf` = ML Kit line confidence.
  `mean_confidence` = average line confidence weighted by text length. `lang` = `latin`, `devanagari` or
  `latin+devanagari`. Limits as in the RPC: text 20 000 characters, 2 000 blocks.
- **Description** (≤ 200 characters): `<operator's category name if tagged, else Photo / Document>; text read from the
  1600 px copy: <first 3 meaningful lines joined with " · ">`, or `<…>; no text read`. "Document" when text lines cover
  ≥ 12 % of the image or there are ≥ 8 lines with ≥ 120 characters. A meaningful line has ≥ 3 letters / digits and is
  mostly letters / digits. The tag name comes from the case's cached chips.
- **Privacy (rule 7, UIDAI):** before anything leaves the phone, every 12-digit number whose first digit is 2–9 (plain or
  grouped 4-4-4 with spaces / hyphens), not part of a longer digit run, becomes `XXXX XXXX 1234` in the text, every
  block and the description; the database applies the same masking again. No checksum test on purpose (a misread digit
  would fail it and leak 11 digits). Other numbers (registration, DL, policy, chassis) are report fields and stay as
  read; a 12-digit segment inside a policy number is masked as well (privacy first; the photo still shows it).
- **Who sees it:** staff on cases they manage (report workspace relevant-files panel, case evidence list: description,
  "Show text", "Copy text"). Field operators never read OCR (RLS, rule 4); they also cannot write OCR rows except
  through `record_device_ocr()`.
- **Server pipeline:** with text and a mean confidence ≥ 70 % (`app_settings.device_ocr_skip_confidence_pct`) the
  queued server `ocr` job of the file is set `skipped` ("device OCR present"); the server worker also skips files with a
  current `mlkit_device` row. If server OCR already read the file, the phone's row is stored beside it, not current.
- **APK size:** the bundled models are expected to add roughly 6–10 MB to the arm64 release APK (about 4 MB per
  script per ABI per Google's figures; **not measured yet**, the APK with this module has not been built — the previous
  arm64 release APK was 39.9 MB). The unbundled Play-services variant would be smaller but needs a model download on
  first use. The Kotlin module is also not compiled yet: check the first build (`ToyamOcrModule.kt` uses
  `Text.Line.confidence`, ML Kit ≥ 16.0.0).
- **Not built yet:** on-device timing log; skipping the Devanagari pass on photos without Devanagari-like noise (would
  halve the time); a battery-saver check; OCR of PDFs on the phone.

## Withdraw

Long-press → Withdraw (within 10 minutes, D19). The message shows "Message withdrawn"; its files disappear for everyone else and cannot be used in reports. Nothing is deleted.

## What operators never see

Staff-only messages (orchestrator ↔ office notes, assignment reasons, "report sent") and any file posted in them are filtered out by the database (D32); the app needs no special handling. The phone reads and sends the OCR text of its photos (above) but can never read OCR rows back (RLS).

## Mark task done

The operator finishes field work from the thread menu (⋮ → **"Mark task done"**; with several open tasks on the case, one entry each: **"Mark done: {title}"**). It calls `complete_field_task(task)` (docs/06).

- **Online only, never queued.** Offline, tapping it shows **"Needs a connection"** — "Marking the task done needs an internet connection, so the office knows at once. Your photos stay saved on this phone. Try again when you are online." Nothing is stored for later, so the operator always knows whether the office has it.
- **Confirmation first:** **"Mark task done?"** with **"Not yet"** / **"Mark done"**. The text names the task, and adds "Checklist: k of n items ticked." when items are unticked (information, not a block: ticks arrive when files are labelled) and "{n} files are still saved on this phone. They will still be sent (within 72 h); keep the app signed in." when the outbox holds files for the case (D43 late uploads accept files captured before the task was marked done).
- **After the call:** "Task marked done" — "This case is now under Completed." (or "{k} more tasks are open on this case."). The thread, the composer's task (photos now need a new request) and the cached case list are refreshed; the Cases list refreshes on focus. A retry after a lost answer is shown as done (the database answers "already completed"); a network failure says "Nothing was changed"; refusals from the database are shown as written (e.g. "This case is no longer open for field work. Ask the office.", a task cancelled by the office).
- Direct `UPDATE` of a task to completed is refused for field users; the office can also mark a task complete (`/tasks/[id]`, docs/12 tasks).

Logic: `src/ui-logic/taskDone.ts` (tests `taskDone.test.ts`); calls `fetchCaseOpenTasks` / `completeTask` in `src/cache/fetch.ts`.

## Completed

A case moves to **Completed** when the operator has no open task on it (after **Mark task done**, or when the office completes, cancels or reassigns the task). A new request from the office reopens it (it returns to **Open** with a notification). Operators can still read the thread and send text on completed cases. Files need an open task, except files **captured before** the task closed or was reassigned: they are accepted for 72 h after that (D43, "Late uploads" below), with no mark in the UI.

## Notifications (FCM)

New task, request (re-investigation), office reply, case reassigned. Tokens in `device_tokens`; content from `notifications`.

## Device and privacy

- Media cached inside the app sandbox only; never saved to the phone gallery.
- Remote sign-out on deactivation (M2 K5): the phone first sends what was captured before deactivation, then clears the cache (D43, "Remote sign-out" below).
- Works offline; queue survives app restarts, reboots, app updates and a killed app; uploads in the background with Android WorkManager (see "Offline experience").
- English interface (D7); voice notes for statements with a consent prompt.

## Build notes

- Expo with a custom development build (share intent handling and ML Kit need native modules). ML Kit lives in the local Expo module `modules/toyam-ocr` (autolinked; no config plugin needed).
- Test on the operators' actual phones early (Android versions and OEM share sheets differ).
