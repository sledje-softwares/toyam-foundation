// App-wide outbox instance (thin wiring, untested). The UI uses getOutbox() / useOutbox().
import 'react-native-get-random-values';
import { openDatabaseAsync } from 'expo-sqlite';
import { supabase } from '../lib/supabase';
import { currentlyOnline, watchConnectivity } from './netinfo';
import { Outbox } from './outbox';
import { uuidV4 } from './sha256';
import { signedInServer } from './signedInServer';
import { openSqliteStore } from './sqliteStore';
import { fileTransport, freeDiskBytes, removeSandboxFile } from './transport';
import { makeCopies } from '../capture/copies';
import { copyEngine } from '../capture/copiesNative';
import { lowStorage } from './selectors';
import { cachedCategoryName } from '../capture/useCaptureContext';
import { readPhoto } from '../ocr/read';
import { ocrEngine } from '../ocr/native';

export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
export const newUuid = (): string => uuidV4(randomBytes(16));

let instance: Promise<Outbox> | null = null;

/** Opens the store, restores the queue and starts watching connectivity (once per process). */
export function getOutbox(): Promise<Outbox> {
  if (!instance) {
    instance = (async () => {
      const store = await openSqliteStore(() => openDatabaseAsync('outbox.db'));
      const outbox = new Outbox({
        store,
        server: signedInServer(supabase),
        transport: fileTransport,
        deviceId: null, // outbox.setDeviceId() after ensureRegisteredDevice()
        uuid: newUuid,
        removeFile: removeSandboxFile,
        // D51: shrunk copies are a nicety, never at the cost of the low-storage guard
        makeCopies: async (f) => {
          try {
            if (lowStorage(await freeDiskBytes(), 0, 0).level !== 'ok') return [];
          } catch {
            return [];
          }
          return makeCopies(copyEngine, f, f.id);
        },
        // gap 35: text of the 1600 px copy + a short description, read on the phone (best effort)
        readOcr: async (f, it) => {
          if (!ocrEngine) return null;
          return readPhoto(ocrEngine, f, await cachedCategoryName(it.case_id, it.category_code));
        },
        log: (m) => console.log(m),
      });
      await outbox.init();
      outbox.setOnline(await currentlyOnline());
      watchConnectivity((online) => outbox.setOnline(online));
      return outbox;
    })();
  }
  return instance;
}
