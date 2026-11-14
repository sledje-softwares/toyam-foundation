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
| `signedInServer.ts` | adapter | `post_thread_message`, `report_outbox_status` (JWT) |
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
| `enqueue(NewItem)` → `OutboxItem` | Send pressed. Copy files into the sandbox first (`adoptIntoSandbox()` in `transport.ts`); pass sha256, size, mime, ext, evidence_type, device_captured_at, gps (camera only), capture_source, checklist_item_id, optional exif / ocr. `task_id` is required for files. |
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
- **TODO: signed-in R2 presigner does not exist yet.** `signedInServer(client, presign?)` takes it as a
  parameter; the default `missingPresigner` throws a transient error, so files wait quietly with
  backoff. Expected reply (same as field-drain `presign`): `{storage_path, url, headers}`; it must check
  `can_upload_evidence_at(task_id, device_captured_at)` and refuse with hint `upload_window_closed`.

## Behaviour notes

- Backoff is global (one job, like WorkManager): 30 s doubling to 30 min, equal jitter; reset on
  connectivity change and "Send now". Offline: the engine stops quietly.
- Restart: `init()` reloads from SQLite; an item cut off mid-upload goes back to `queued`; files
  already in R2 (`storage_path` set) are not uploaded again.
- Sandbox files are deleted after the message is stored (✓), on "Remove from phone", and on wipe.
- Background: `background.ts` (imported in `app/_layout.tsx`) defines the task; call
  `registerOutboxBackgroundTask()` after sign-in and `unregisterOutboxBackgroundTask()` on sign-out.
  The foreground-service progress notification ("Sending 3 of 12 files") is not built yet.
