// Share target (build plan 5.6, docs/11 "Share to Toyam"): pure mapping from the Android share intent
// (expo-share-intent's native payload) to the share inbox and then to the composer draft of the chosen
// case. Shared files are treated exactly like gallery picks (D18: no mark, no block); only
// capture_source = 'share' records the origin. Native side effects live in ./inbox.ts and app/share.tsx.
import type { CaseRow } from '../lib/cases';
import { checkFile, extFor, MB, mimeOf } from '../capture/limits';
import type { Picked } from '../capture/prepare';

/** One file of the Android payload (ExpoShareIntentModule `onChange` → value.files[]). Fields are strings or null. */
export interface NativeSharedFile {
  contentUri?: string | null;
  filePath?: string | null;
  fileName?: string | null;
  fileSize?: string | number | null;
  mimeType?: string | null;
  width?: string | number | null;
  height?: string | number | null;
}

/** A shared file as the app reads it. `uri` is the content:// URI the sender granted (readable now). */
export interface SharedSource {
  uri: string;
  name: string | null;
  mime: string;
  size: number | null;
  width: number | null;
  height: number | null;
}

export interface Rejected {
  name: string;
  message: string;
}

/** More files than this in one share are refused with a message (the outbox splits by 30 per message). */
export const MAX_SHARED_FILES = 100;

export const TEXT_ONLY_MESSAGE = 'Only photos, videos, audio and PDF files can be shared to Toyam. Type text in the case thread instead.';
export const TOO_MANY_MESSAGE = `At most ${MAX_SHARED_FILES} files can be shared at once. Share the rest separately.`;

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Files of a share payload. The content:// URI comes first: on Android 10+ the sender grants it, while
 * a file path from MediaStore is usually unreadable without storage permission (which the app does not ask for).
 */
export function parseSharePayload(value: unknown): { files: SharedSource[]; text: string | null } {
  const v = (value && typeof value === 'object' ? value : {}) as { files?: unknown; text?: unknown };
  const list = Array.isArray(v.files) ? (v.files as unknown[]) : [];
  const files: SharedSource[] = [];
  for (const raw of list) {
    // the module's single-file payload carries a stray ["type", "file"] pair in the array: skip non-objects
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const f = raw as NativeSharedFile;
    const uri = f.contentUri || (f.filePath ? (f.filePath.startsWith('file://') ? f.filePath : `file://${f.filePath}`) : null);
    if (!uri) continue;
    const name = typeof f.fileName === 'string' && f.fileName.trim() ? f.fileName.trim().slice(0, 200) : null;
    files.push({ uri, name, mime: mimeOf(f.mimeType, name), size: num(f.fileSize), width: num(f.width), height: num(f.height) });
  }
  const text = typeof v.text === 'string' && v.text.trim() ? v.text : null;
  return { files, text };
}

/** Type and size checks before anything is copied (same caps as evidence-upload, capture/limits.ts). */
export function screenShared(files: readonly SharedSource[]): { accepted: SharedSource[]; rejected: Rejected[] } {
  const accepted: SharedSource[] = [];
  const rejected: Rejected[] = [];
  for (const f of files) {
    const name = f.name ?? 'A shared file';
    if (accepted.length >= MAX_SHARED_FILES) {
      rejected.push({ name, message: TOO_MANY_MESSAGE });
      continue;
    }
    // unknown size: decided after the copy (finish() checks the copied bytes)
    const check = checkFile(f.mime, f.size ?? 1);
    if (!check.ok) rejected.push({ name, message: check.message });
    else accepted.push(f);
  }
  return { accepted, rejected };
}

/** A shared file copied into the app (survives sign-in, restarts and the sender revoking access). */
export interface InboxFile {
  local_path: string;
  name: string | null;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
}

export interface ShareInbox {
  received_at: string;
  files: InboxFile[];
  rejected: Rejected[];
}

export const EMPTY_INBOX: ShareInbox = { received_at: '', files: [], rejected: [] };

/** Adds one share to the inbox (a second share before a case was chosen is appended, duplicates by path dropped). */
export function mergeInbox(cur: ShareInbox | null, add: { files: InboxFile[]; rejected: Rejected[] }, nowIso: string): ShareInbox {
  const base = cur ?? EMPTY_INBOX;
  const have = new Set(base.files.map((f) => f.local_path));
  return {
    received_at: base.received_at || nowIso,
    files: [...base.files, ...add.files.filter((f) => !have.has(f.local_path))].slice(0, MAX_SHARED_FILES),
    rejected: [...base.rejected, ...add.rejected].slice(0, 50),
  };
}

/** Sandbox name of an inbox copy: `<id>.<ext>`. */
export function inboxName(id: string, mime: string): string {
  const safe = id.toLowerCase().replace(/[^0-9a-z-]/g, '') || 'file';
  return `${safe}.${extFor(mime) ?? 'bin'}`;
}

/** The inbox copy as a gallery-like pick for preparePicked(…, 'share'). */
export const toPicked = (f: InboxFile): Picked => ({
  uri: f.local_path, mimeType: f.mime, name: f.name, size: f.size, width: f.width ?? 0, height: f.height ?? 0, exif: null, lastModified: null,
});

/** Case choice: only cases with an open task take files ("Open" tab), newest activity first. */
export function shareCaseChoices(rows: readonly CaseRow[]): CaseRow[] {
  return rows
    .filter((r) => r.list === 'open')
    .sort((a, b) => (b.last_message_at ?? '').localeCompare(a.last_message_at ?? ''));
}

export const NO_OPEN_CASE = {
  title: 'No open case',
  body: 'You have no open case to send these files to. Files can only be sent to a case the office has asked you to work on. Remove them, or keep them on this phone until the office gives you a case.',
  remove: 'Remove the files',
  keep: 'Keep for now',
} as const;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Heading of the share screen. */
export function shareHeading(inbox: ShareInbox): string {
  const mb = inbox.files.reduce((s, f) => s + f.size, 0) / MB;
  return inbox.files.length === 0
    ? 'Nothing to send'
    : `${plural(inbox.files.length, 'file')} to send${mb >= 0.1 ? ` · ${mb.toFixed(1)} MB` : ''}`;
}

/** Banner on the case list while shared files wait for a case (nothing is kept silently). */
export function inboxBanner(inbox: ShareInbox | null): string | null {
  const n = inbox?.files.length ?? 0;
  return n > 0 ? `${plural(n, 'shared file')} waiting — choose a case` : null;
}
