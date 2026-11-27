# Outbox (M5 5.7, D43)

Offline-first sending for the field app. Every message is saved on the phone first (🕓), then sent
by itself: files to R2, then `post_thread_message()` with the same `client_message_id` on every retry
(rule 6). Nothing is ever shown as "failed". Spec: `docs/11-field-app.md` "Offline experience".

## Files

| File | Kind | What |
|---|---|---|
| `types.ts` | pure | `OutboxItem`, `OutboxFile`, `ItemState`, `NewItem` |
| `outbox.ts` | pure | `Outbox` engine (injected store / server / transport / clock) |
| `selectors.ts` | pure | everything the UI renders (spec 1–10, exact wording) |
| `server.ts` | pure | `Server`, `DrainServer`, `Transport`, `ServerError`, error mapping |
| `store.ts` | pure | `Store` interface + `MemoryStore` (tests) |
| `backoff.ts`, `stateMachine.ts`, `sha256.ts` | pure | 30 s → 30 min with jitter; allowed transitions; SHA-256 / uuid v4 |
| `signedInServer.ts` | adapter | `post_thread_message`, `report_outbox_status`, `evidence-upload` presign (JWT) |
| `drainServer.ts` | adapter | `field-drain` edge function (status / presign / post / outbox / finish) |
| `device.ts` | adapter | `ensureRegisteredDevice()` → `register_field_device(id, sha256(secret))` |
| `sqliteStore.ts`, `transport.ts`, `netinfo.ts` | native | expo-sqlite, expo-file-system (sandbox + PUT), NetInfo |
| `runtime.ts`, `useOutbox.ts`, `background.ts` | native | singleton, React hook, expo-background-task job |

## Using it from the UI

```ts
import { useOutbox } from '@/outbox/useOutbox';
import { offlineBar, outboxSummary, outboxHeader, pendingTicks, freshness, needsGentlePrompt,
         canSignOut, lowStorage, lastTryLine, outboxTotals } from '@/outbox';

const { outbox, snapshot } = useOutbox();          // outbox null until the store has loaded
```

`snapshot: OutboxSnapshot` = `{ items, online, mode: 'normal'|'drain', paused, sending: {k,n}|null,
last_success_at, last_prompt_at, next_retry_at }`. It is stable between changes.

### Commands (`outbox.*`)

| Call | When |
|---|---|
| `enqueue(NewItem)` → `OutboxItem` | Send pressed. Copy files into the sandbox first (`adoptIntoSandbox()` in `transport.ts`); pass sha256, size, mime, ext, evidence_type, device_captured_at, gps (camera only), capture_source, checklist_item_id, optional exif. `task_id` is required for files. Device OCR is made by the outbox itself (below). |
| `sendNow(caseId?)` | "Send now" (sheet, Outbox card, prompt). Resets backoff, retries held items. |
| `retryHeld(caseId, newTaskId)` | The operator got a new open task on a case with held files (from `field_case_list()` / a push). Re-uploads under the new task. |
| `removeFile(clientMessageId, fileId)` | Only after the "Remove this file?" confirmation. Unsent files only. |
| `markTicks([{client_message_id, state:'processed'\|'seen'}])` | Optional; ticks only move forward. Once the queue is empty, sent rows are dropped and the thread uses server ticks. |
| `markPrompted()` | After showing the 6-hour prompt. |
| `setDeviceId(id)` | After `ensureRegisteredDevice()` at sign-in; enables outbox reports. |
| `useServer(drainServer(...), 'drain')` | Remote sign-out with `status = 'drain'`. |
| `wipe()` → discarded file count | Sign-out (only when `canSignOut` allows) or after drain `finish`. |
| `onEvent(fn)` | `all_sent {count, case_id}` (spec 6, once per drain; suppress when that thread is open), `auth_blocked` (call field-drain `status`), `drain_closed` (call `finish`, wipe), `reactivated` (normal sign-in). |

### Selectors (pure, tested)

| Selector | Returns |
|---|---|
| `offlineBar({online, items, sending})` | `{kind:'hidden'}` \| `{kind:'offline', count, bytes, text}` \| `{kind:'sending', k, n, text}` |
| `lastTryLine(item.last_attempt_at, now)`, `CLOCK_SHEET` | 🕓 sheet (spec 2) |
| `outboxSummary(items)` | per case: `{case_id, total_files, sent_files, pending_files, pending_bytes, held_files, progress, sending, last_attempt_at, progress_text, held_text}` |
| `outboxHeader(items)` | `{empty, text, menu_label}` ("Outbox (N)", null when empty); `REMOVE_FILE_DIALOG` |
| `freshness(lastSyncedAt, now)` | `{text: 'Updated 2 h ago', stale}` (stale = amber, > 24 h) |
| `pendingTicks(checklist, items, online)` | `[{checklist_item_id, caption: 'Sending…'\|'Saved on phone'}]` for unticked items matched by category chip or picked item |
| `needsGentlePrompt(oldestQueuedAt, now, {lastSuccessAt, lastPromptAt})`, `gentlePromptText(n)` | spec 7 |
| `lowStorage(freeBytes, queuedBytes, queuedFiles)` | `{level:'ok'}` \| `{level:'warn', banner}` \| `{level:'block', banner, dialog}` (`freeDiskBytes()` in `transport.ts`) |
| `canSignOut(items)` | `{allowed:true}` \| `{allowed:false, count, title, body, buttons}` |
| `allSentEvent(batch, pendingFiles, now)`, `allSentNotification(n)` | spec 6 (the engine fires `all_sent`) |
| `drainProgress(items)`, `DRAIN_PAGE`, `drainDoneText(sent, discarded)` | spec 10 |
| `outboxTotals(items)` | `{items, files, bytes, held_files, oldest_queued_at, oldest_captured_at}` |

## Server calls

- `post_thread_message(p_case_id, p_client_message_id, p_kind, p_body, p_task_id, p_reply_to, p_items)` — idempotent.
  `42501` + hint `upload_window_closed` → a multi-file message is split into one message per file
  (new ids, persisted atomically); a single refused file becomes `held` ("Waiting for the office").
- `report_outbox_status(p_device_id, p_pending_count, p_pending_bytes, p_oldest_pending_at)` — after each
  send and at most once a minute on changes, only while online and registered.
- `register_field_device(p_device_id, p_secret_sha256, 'android')` — secret stays in secure storage.
- `field-drain` (no JWT): `status`, `presign`, `post`, `outbox`, `finish` — see docs/11.
- `evidence-upload` (JWT, `supabase/functions/evidence-upload/README.md`): the default presigner of
  `signedInServer(client, presign?)` (`evidenceUploadPresigner`), one file per call with `sha256`, `size`,
  `mime`, `device_captured_at`. Reply `upload` → PUT to `url` with `headers` (hash and size are signed);
  `already_stored` → the case already holds that hash, so the PUT is skipped and the file is still posted.
  Errors: 401 → auth, 403 `upload_window_closed` → window_closed, other 400 / 403 / 413 → rejected (held),
  5xx / network → transient.

## Shrunk copies of photos (D51)

Every image the app sends (camera, gallery, share-in; jpeg / png / heic / heif / webp) also gets two JPEG
copies: 1600 px (reports) and 384 px (labelling) on the long edge, quality 0.8, upright, **no EXIF / GPS**,
never enlarged (an image smaller than the target keeps its size). They are a rebuildable cache, not
evidence: the operator sees them only as thread thumbnails / viewer images (seeded into the thread image cache
when made, `src/thread/fileStore.ts`), and any failure drops the copy silently (the report then uses the
original). The server never decodes images.

| Piece | Where |
|---|---|
| Planning (sizes, no upscale, order, caps; pure, tested with a fake decoder) | `src/capture/copies.ts`, `copies.test.ts` |
| Native decoder / hashing / sandbox (`expo-image-manipulator`, `File.digest`) | `src/capture/copiesNative.ts` |
| Engine (making, sending, dropping; tested) | `outbox.ts` (`startCopies`, `sendCopiesPass`, `sendCopies`), `copies.test.ts` here |
| Server calls | `Server.presignDerivatives` (evidence-upload `derivatives`), `Server.recordDerivative` (`record_device_derivative`) |

- **Making:** `enqueue()` saves the message at once, then makes the copies in the background (one photo at
  a time, 1600 then 384), hashes each (SHA-256 of the copy's own bytes), stores them in the outbox sandbox
  (`copy-<fileId>-w<width>.jpg`) and records them on the file (`OutboxFile.copies`, persisted in the item
  JSON; no store migration needed, old items simply have none). Sending a message waits for its copy job so
  the original is still in the sandbox. Skipped when the free-space guard is not `ok` (`runtime.ts`) and in
  drain mode. After a restart, queued photos saved without copies get them then.
- **Sending order per photo:** original PUT → `post_thread_message` (message stored ✓) → one
  `evidence-upload` call with both copies → PUT each → `record_device_derivative`. Copies go only while no
  message is waiting, under the same global backoff.
- **Outcomes:** `skipped` / `already_stored` / refused (window closed, rejected, photo withdrawn) → the copy
  is dropped; transient errors back off and retry, a copy is dropped after `MAX_COPY_ATTEMPTS` (6) failures;
  an expired session pauses sending like for files. Copies never hold a message.
- **Drain (remote sign-out):** `field-drain` has no copy calls; copies are skipped and deleted at `wipe()`.
- **Invisible in the counts:** counts, ticks, the "Sending k of n" bar and sign-out checks cover messages and files only.
  A sent row stays in the store (not shown as pending) until its copies are done, then it is pruned.
- **Cleanup:** copy files are deleted after the record call, when a file is removed from the phone, and on wipe.
- **Orientation / metadata:** the copy is rendered by `ImageManipulator` (decoded upright) and re-encoded
  with `saveAsync` (Android `Bitmap.compress`: pixels only). Not verified on a device yet: shoot a portrait
  photo and a gallery photo with GPS EXIF, open the copy and check it is upright and has no EXIF.

## Device OCR of photos (gap 35)

Every photo that got copies is also read on the phone (ML Kit, Latin + Devanagari, bundled models; native module
`modules/toyam-ocr`, pure logic `src/ocr/`): text and blocks of the **1600 px copy**, text as read (D55: no masking before the report), plus a
short description (`<tag or Photo/Document>; text read from the 1600 px copy: …`). Spec: docs/11 "Device OCR and description".

| Piece | Where |
|---|---|
| Read step (`readPhoto`: 1600 px copy only, limits, never throws) | `src/ocr/read.ts`; engine injected as `OutboxDeps.readOcr` (wired in `runtime.ts`) |
| Engine (`startOcr`, `sendOcr`, shared `onSideError`) | `outbox.ts`, tests `ocr.test.ts` here |
| Server call | `Server.recordOcr` (`record_device_ocr`, signed-in server only) |

- **State:** `OutboxFile.ocr` — `undefined` not read yet, `null` nothing to send, object = to record (persisted in the item
  JSON, like the copies). After a restart, a photo whose 1600 px copy is still on the phone and not read yet is read then.
- **Order:** read after the copies are made (own chain, one photo at a time; the message is not kept waiting). A photo's
  copies are not sent while it is being read (the 1600 px file must exist). Then copies, then the text.
- **Outcomes:** same as copies — refused → dropped, transient → backoff and `attempts` (dropped after 6), session trouble
  pauses. Never in `post_thread_message` items, never visible to the operator; a sent row stays until its copies and text are
  done. Drain mode: neither read nor sent.
- `whenIdle()` resolves once no copy job, OCR job or sending pass is left (tests).

## File comments (D54): sibling queue, not an item kind

Comments on a file are not thread messages, so they do not go through this engine: `src/comments/queue.ts`
(`CommentQueue`) is a small sibling with the same rules — saved first, oldest first, **this module's `backoffDelay`**,
idempotent `client_comment_id` on `add_evidence_comment`, refusals kept as `held` with a reason (never "failed"),
`classifyPgError` classes (`src/comments/server.ts`). Own SQLite file `comments.db` (table `outbox_comments`), so the
outbox's transactions on `outbox.db` are never shared with comment writes. Not counted in this module's totals, ticks,
sign-out check or drain; `OutboxProvider` asks separately at sign-out (`commentSignOutView`), wipes it with the outbox,
and `background.ts` runs it after `outbox.run()`. Spec: docs/11 "File details and comments".

## Behaviour notes

- Backoff is global (one job, like WorkManager): 30 s doubling to 30 min, equal jitter; reset on
  connectivity change and "Send now". Offline: the engine stops quietly.
- Restart: `init()` reloads from SQLite; an item cut off mid-upload goes back to `queued`; files
  already in R2 (`storage_path` set) are not uploaded again.
- Sandbox files are deleted after the message is stored (✓), on "Remove from phone", and on wipe.
- Background: `background.ts` (imported in `app/_layout.tsx`) defines the task; call
  `registerOutboxBackgroundTask()` after sign-in and `unregisterOutboxBackgroundTask()` on sign-out.
  The foreground-service progress notification ("Sending 3 of 12 files") is not built yet.
