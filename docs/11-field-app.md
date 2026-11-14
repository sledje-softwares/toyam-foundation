# 11 — Field App (M5, D17–D19)

Android app for field operators. It should feel like the chat app they already use every day — same interaction patterns, own name and branding — so that sending a photo to a case is as quick as sending it to an office WhatsApp group.

## Screens

```
┌ Cases ───────────────────────┐   ┌ ← INV-2026-000123 · Ravi S ────┐
│ [ Open (3) ]  Completed      │   │ ⋮ menu ▸ Checklist (5/9)        │  menu option (D41)
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
| Cases | Tabs **Open** (has an open task) / **Completed**; last message preview, time, unread badge; search by name / claim no. / vehicle | `field_case_list()` |
| Thread | Case header (insured, vehicle, location, insurer points), pinned checklist, messages incl. system events and requests, composer | `case_messages`, `case_field_values` (intake only), `v_case_checklist` |
| Camera | In-app camera, burst, document mode (edge crop) | local |
| Picker | Gallery and documents, multi-select | local |
| Share target | "Share → Toyam" from any app → choose case (Open first) → optional caption and tag → send | Android intent `ACTION_SEND` / `ACTION_SEND_MULTIPLE` for `image/*`, `video/*`, `application/pdf`, `audio/*` |
| Checklist | Opened from the thread's menu (D41); items with progress; **ticks itself once a file is labelled and matched** (D30, D35); tap an item to capture directly into it | `task_checklist_items`, `v_case_checklist`, `evidence_labels` (realtime) |

## Sending

1. Operator captures or selects files; optional caption; optional one-tap category chip (from the checklist's categories).
2. App compresses photos (~0.5–1 MB), computes SHA-256, reads GPS (camera only), keeps EXIF, runs ML Kit OCR on document-like photos.
3. Message is stored locally with a new `client_message_id` → shown with 🕓.
4. When online: presigned upload to R2 for each file (`can_upload_evidence(task)`), then `post_thread_message()` with the items. Retries reuse the same `client_message_id`, so nothing is duplicated.

Gallery and shared files are accepted exactly like camera captures — no mark, no block (D18). The origin is kept internally in `capture_source`.

## Ticks

| Tick | Meaning | Source |
|---|---|---|
| 🕓 | Waiting to upload | local queue |
| ✓ | Stored on the server | message row exists |
| ✓✓ | Processed (read and labelled) | `v_evidence_processing.state = done` for all files |
| blue ✓✓ | Seen by office | `case_thread_state().staff_last_read_at ≥ message time` |

## Withdraw

Long-press → Withdraw (within 10 minutes, D19). The message shows "Message withdrawn"; its files disappear for everyone else and cannot be used in reports. Nothing is deleted.

## What operators never see

Staff-only messages (orchestrator ↔ office notes, assignment reasons, "report sent") and any file posted in them are filtered out by the database (D32); the app needs no special handling.

## Completed

A case moves to **Completed** when the operator has no open task on it. A new request from the office reopens it (it returns to **Open** with a notification). Operators can still read the thread and send text on completed cases; files need an open task.

## Notifications (FCM)

New task, request (re-investigation), office reply, case reassigned. Tokens in `device_tokens`; content from `notifications`.

## Device and privacy

- Media cached inside the app only; never saved to the phone gallery.
- Remote sign-out on deactivation (M2 K5) clears the cache.
- Works offline; queue survives app restarts; uploads in the background with progress.
- English interface (D7); voice notes for statements with a consent prompt.

## Build notes

- Expo with a custom development build (share intent handling and ML Kit need native modules).
- Test on the operators' actual phones early (Android versions and OEM share sheets differ).
