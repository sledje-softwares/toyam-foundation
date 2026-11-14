// Builds the outbox `NewItem`s for one press of Send (pure). The outbox adds the client_message_id.
import type { CaptureSource, Gps, NewItem } from '../outbox/types';

export type PreparedFile = NewItem['files'][number];

/** At most 30 files per message (post_thread_message); larger batches become several messages. */
export const MAX_FILES_PER_MESSAGE = 30;
export const MAX_TEXT = 4000;

export const NO_TASK_TEXT = 'This case is completed. You can still send messages; photos and files need a new request from the office.';

export interface SendInput {
  caseId: string;
  /** The operator's open task on the case; null on a completed case (text only). */
  taskId: string | null;
  text: string;
  categoryCode: string | null;
  files: readonly PreparedFile[];
}

export type BuildResult = { ok: true; items: NewItem[] } | { ok: false; message: string };

export function buildNewItems(input: SendInput): BuildResult {
  const text = input.text.trim().slice(0, MAX_TEXT);
  // the same file picked twice is sent once (evidence is unique per case and hash, rule 6)
  const seen = new Set<string>();
  const files = input.files.filter((f) => !seen.has(f.sha256) && (seen.add(f.sha256), true));
  if (!text && files.length === 0) return { ok: false, message: 'Type a message or add a photo.' };
  if (files.length > 0 && !input.taskId) return { ok: false, message: NO_TASK_TEXT };
  if (files.length === 0) {
    return { ok: true, items: [{ case_id: input.caseId, task_id: input.taskId, kind: 'text', caption: text, category_code: null, files: [] }] };
  }
  const items: NewItem[] = [];
  for (let i = 0; i < files.length; i += MAX_FILES_PER_MESSAGE) {
    items.push({
      case_id: input.caseId,
      task_id: input.taskId,
      kind: 'media',
      caption: i === 0 && text ? text : null,
      category_code: input.categoryCode,
      files: files.slice(i, i + MAX_FILES_PER_MESSAGE),
    });
  }
  return { ok: true, items };
}

/** Sandbox file name: `<uuid>.<ext>` (the original name is kept in `original_filename`). */
export function sandboxName(id: string, ext: string): string {
  const safeId = id.toLowerCase().replace(/[^0-9a-f-]/g, '');
  const safeExt = ext.toLowerCase().replace(/[^0-9a-z]/g, '') || 'bin';
  if (!safeId) throw new Error('sandboxName: empty id');
  return `${safeId}.${safeExt}`;
}

/** Original name for the office: the picker's name, or a readable one for camera shots. */
export function originalName(source: CaptureSource, pickedName: string | null | undefined, capturedAtIso: string, ext: string): string | null {
  const n = pickedName?.trim();
  if (n) return n.slice(0, 200);
  if (source !== 'camera') return null;
  const stamp = capturedAtIso.replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '').replace('T', '_');
  return `IMG_${stamp}.${ext}`;
}

/** Accuracy rounded to a metre; null coordinates mean "no GPS". */
export function gpsFrom(coords: { latitude: number; longitude: number; accuracy?: number | null } | null | undefined): Gps | null {
  if (!coords || !Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) return null;
  const acc = coords.accuracy;
  return { latitude: coords.latitude, longitude: coords.longitude, accuracy_m: typeof acc === 'number' && Number.isFinite(acc) ? Math.round(acc) : null };
}
