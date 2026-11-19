// Share inbox (5.6; thin native adapter, logic in ./intent.ts). A share is copied into the app at once
// (documentDirectory/share-inbox/), because the sender's content:// grant ends with the activity, and the
// list is saved as JSON, so shared files wait through sign-in and restarts until the operator picks a
// case (app/share.tsx) or removes them. Cleared on sign-out / drain wipe.
import * as FS from 'expo-file-system/legacy';
import { newUuid } from '../outbox/runtime';
import { inboxName, mergeInbox, parseSharePayload, screenShared, TEXT_ONLY_MESSAGE, type InboxFile, type Rejected, type ShareInbox } from './intent';

export const INBOX_DIR = `${FS.documentDirectory ?? ''}share-inbox/`;
const INBOX_JSON = `${FS.documentDirectory ?? ''}share-inbox.json`;

let memory: ShareInbox | null | undefined;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function subscribeInbox(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function loadInbox(): Promise<ShareInbox | null> {
  if (memory !== undefined) return memory;
  try {
    const info = await FS.getInfoAsync(INBOX_JSON);
    memory = info.exists ? (JSON.parse(await FS.readAsStringAsync(INBOX_JSON)) as ShareInbox) : null;
  } catch {
    memory = null;
  }
  return memory;
}

/** The last loaded value (for useSyncExternalStore); call loadInbox() once first. */
export const inboxSnapshot = (): ShareInbox | null => memory ?? null;

async function save(inbox: ShareInbox | null): Promise<void> {
  memory = inbox && (inbox.files.length > 0 || inbox.rejected.length > 0) ? inbox : null;
  try {
    if (memory) await FS.writeAsStringAsync(INBOX_JSON, JSON.stringify(memory));
    else await FS.deleteAsync(INBOX_JSON, { idempotent: true });
  } catch {
    // kept in memory for this run
  }
  emit();
}

/** Copy the shared files of one intent into the inbox. Returns the inbox (null = nothing usable). */
export async function receiveShare(payload: unknown): Promise<ShareInbox | null> {
  const parsed = parseSharePayload(payload);
  const { accepted, rejected } = screenShared(parsed.files);
  if (parsed.files.length === 0 && parsed.text) rejected.push({ name: 'Shared text', message: TEXT_ONLY_MESSAGE });
  await FS.makeDirectoryAsync(INBOX_DIR, { intermediates: true }).catch(() => {});
  const files: InboxFile[] = [];
  const failed: Rejected[] = [];
  for (const f of accepted) {
    const to = `${INBOX_DIR}${inboxName(newUuid(), f.mime)}`;
    try {
      await FS.copyAsync({ from: f.uri, to });
      const info = await FS.getInfoAsync(to);
      files.push({ local_path: to, name: f.name, mime: f.mime, size: info.exists ? info.size : f.size ?? 0, width: f.width, height: f.height });
    } catch {
      failed.push({ name: f.name ?? 'A shared file', message: 'This file could not be read. Share it again, or add it from the gallery.' });
    }
  }
  const next = mergeInbox(await loadInbox(), { files, rejected: [...rejected, ...failed] }, new Date().toISOString());
  await save(next);
  return memory ?? null;
}

/** Remove one inbox copy (after it was prepared into the outbox sandbox, or removed by the operator). */
export async function removeInboxFile(path: string): Promise<void> {
  if (!path.startsWith(INBOX_DIR)) return;
  await FS.deleteAsync(path, { idempotent: true }).catch(() => {});
  const cur = await loadInbox();
  if (cur) await save({ ...cur, files: cur.files.filter((f) => f.local_path !== path) });
}

/** Forget the refusal notes once shown. */
export async function clearInboxNotes(): Promise<void> {
  const cur = await loadInbox();
  if (cur) await save({ ...cur, rejected: [] });
}

/** Delete everything (operator removed the files, sign-out, drain wipe). */
export async function clearInbox(): Promise<void> {
  await FS.deleteAsync(INBOX_DIR, { idempotent: true }).catch(() => {});
  await save(null);
}
