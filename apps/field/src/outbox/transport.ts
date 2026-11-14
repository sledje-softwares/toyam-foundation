// expo-file-system transport and sandbox helpers (thin adapters, untested).
import * as FS from 'expo-file-system/legacy';
import { ServerError, type Transport } from './server';

/** Queued files live here: inside the app sandbox, never the gallery; cleared on wipe. */
export const OUTBOX_DIR = `${FS.documentDirectory ?? ''}outbox/`;

export const fileTransport: Transport = {
  async put(url, headers, localPath, onProgress) {
    const task = FS.createUploadTask(
      url,
      localPath,
      {
        httpMethod: 'PUT',
        headers,
        uploadType: FS.FileSystemUploadType.BINARY_CONTENT,
        sessionType: FS.FileSystemSessionType.BACKGROUND,
      },
      (p) => onProgress(p.totalBytesSent),
    );
    let res;
    try {
      res = await task.uploadAsync();
    } catch (e) {
      throw new ServerError('transient', 'network', e instanceof Error ? e.message : String(e));
    }
    if (!res) throw new ServerError('transient', 'upload_cancelled');
    // Any non-2xx (expired URL, checksum mismatch, 5xx): retry later with a fresh presign. Logged only.
    if (res.status < 200 || res.status >= 300) throw new ServerError('transient', `r2_${res.status}`);
  },
};

/** Copy a captured / shared file into the sandbox; returns the new URI. */
export async function adoptIntoSandbox(sourceUri: string, name: string): Promise<string> {
  await FS.makeDirectoryAsync(OUTBOX_DIR, { intermediates: true }).catch(() => {});
  const to = `${OUTBOX_DIR}${name}`;
  await FS.copyAsync({ from: sourceUri, to });
  return to;
}

export async function removeSandboxFile(uri: string): Promise<void> {
  if (!uri.startsWith(OUTBOX_DIR)) return; // never touch files outside the outbox folder
  await FS.deleteAsync(uri, { idempotent: true });
}

export const freeDiskBytes = (): Promise<number> => FS.getFreeDiskStorageAsync();
