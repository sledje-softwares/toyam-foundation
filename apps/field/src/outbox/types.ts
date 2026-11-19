// Outbox model (M5 5.7, D43). Pure types: no React Native imports, so the core runs under vitest.

/**
 * queued → uploading → stored (✓) → processed (✓✓) → seen (blue ✓✓); `held` = refused by the server
 * and waiting for office action. There is deliberately no "failed" state toward the user.
 */
export type ItemState = 'queued' | 'uploading' | 'stored' | 'processed' | 'seen' | 'held';

/** Why an item is held (internal; the UI shows "Waiting for the office" for all of them). */
export type HeldReason =
  | 'upload_window_closed' // D43 late-upload rule refused the file (single-file message)
  | 'rejected' // other server refusal (invalid input, duplicate, ...) — kept for the office / logs
  | 'drain_text'; // remote sign-out: text-only messages are not drained

export type CaptureSource = 'camera' | 'gallery' | 'share';
export type EvidenceType = 'photo' | 'video' | 'audio' | 'document';
export type MessageKind = 'text' | 'media' | 'voice';

export interface Gps {
  latitude: number;
  longitude: number;
  accuracy_m: number | null;
}

/** One OCR line in the documented evidence_ocr shape (docs/10): pixel box of the image that was read. */
export interface OcrBlock {
  text: string;
  /** [x, y, w, h] in the 1600 px copy's pixels. */
  bbox: [number, number, number, number];
  conf: number | null;
  /** Reading-order index. */
  line: number;
}

/**
 * Text read on the phone from the 1600 px copy (ML Kit, Latin + Devanagari) with a short description,
 * waiting for record_device_ocr(). Aadhaar-like numbers are already masked (src/ocr/mask.ts).
 * Best effort and invisible to the operator, like the copies.
 */
export interface OutboxOcr {
  engine_version: string;
  lang: string | null;
  text: string;
  blocks: OcrBlock[];
  mean_confidence: number | null;
  /** "<tag or Photo/Document>; text read from the 1600 px copy: ..." (<= 200 characters). */
  description: string;
  source_width: 1600;
  /** Failed tries; dropped after MAX_COPY_ATTEMPTS like a copy. */
  attempts: number;
}

/**
 * A shrunk JPEG copy of an image (D51): 1600 px for reports, 384 px for labelling. A rebuildable cache,
 * not evidence: no EXIF / GPS, shown to the operator only as thread thumbnails (src/thread), dropped silently when it cannot be made or
 * uploaded (the report then uses the original). Present on the file only while it still has to be sent.
 */
export interface OutboxCopy {
  width: 384 | 1600;
  /** file:// URI inside the outbox sandbox. */
  local_path: string;
  /** SHA-256 hex of the copy's own bytes. */
  sha256: string;
  size_bytes: number;
  pixel_width: number;
  pixel_height: number;
  /** Set once the PUT to R2 succeeded (only the record call is left). */
  storage_path: string | null;
  /** Failed tries; the copy is dropped after MAX_COPY_ATTEMPTS. */
  attempts: number;
}

/** A copy is tried this many times (each failure counts) before it is dropped silently. */
export const MAX_COPY_ATTEMPTS = 6;

export interface OutboxFile {
  /** Local id (uuid). */
  id: string;
  /** file:// URI inside the app sandbox (documentDirectory/outbox/…), never the gallery. */
  local_path: string;
  /** SHA-256 hex, computed on the device (rule 3). */
  sha256: string;
  size_bytes: number;
  mime_type: string;
  /** Lower-case extension without the dot, e.g. "jpg". */
  ext: string;
  evidence_type: EvidenceType;
  /** Device clock (untrusted; the server only accepts it inside a server-clock window). */
  device_captured_at: string;
  /** Camera captures only. */
  gps: Gps | null;
  /** Audit only; gallery / shared files are not marked or blocked (D18). */
  capture_source: CaptureSource;
  original_filename: string | null;
  /** Checklist item the operator picked, if any. */
  checklist_item_id: string | null;
  exif?: Record<string, unknown>;
  device_info?: Record<string, unknown>;
  /**
   * Device OCR (gap 35): undefined = not read yet (or a file saved before OCR existed), null = nothing
   * to send (read failed, not a photo, already recorded or dropped), object = to record.
   */
  ocr?: OutboxOcr | null;
  /** Shrunk copies still to send (images only); absent on items saved before copies existed. */
  copies?: OutboxCopy[];
  /** Set once the PUT to R2 succeeded; a stored file is never uploaded again. */
  storage_path: string | null;
  /** Upload progress of the current attempt (not persisted mid-file). */
  bytes_sent: number;
}

export interface OutboxItem {
  /** Created on the device; every retry reuses it (rule 6). */
  client_message_id: string;
  case_id: string;
  task_id: string | null;
  kind: MessageKind;
  caption: string | null;
  /** One-tap category chip (evidence_categories.code), applied to every file. */
  category_code: string | null;
  reply_to: string | null;
  files: OutboxFile[];
  state: ItemState;
  /** Device clock: when the operator pressed send. */
  created_at: string;
  attempts: number;
  last_attempt_at: string | null;
  /** Internal error reason, for logs only. Never shown as "failed". */
  last_error: string | null;
  held_reason: HeldReason | null;
  /** Server message id once stored (✓). */
  message_id: string | null;
  stored_at: string | null;
  /** Set on the per-file messages created by the late-upload split. */
  split_from: string | null;
}

/** What the UI passes to `enqueue`; the outbox adds ids and state. */
export interface NewItem {
  case_id: string;
  task_id: string | null;
  kind?: MessageKind;
  caption?: string | null;
  category_code?: string | null;
  reply_to?: string | null;
  files: Omit<OutboxFile, 'id' | 'storage_path' | 'bytes_sent'>[];
}

/** States that still hold data on the phone. */
export const PENDING_STATES: readonly ItemState[] = ['queued', 'uploading', 'held'];
export const isPending = (i: OutboxItem): boolean => PENDING_STATES.includes(i.state);
