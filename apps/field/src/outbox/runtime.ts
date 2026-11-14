// App-wide outbox instance (thin wiring, untested). The UI uses getOutbox() / useOutbox().
import 'react-native-get-random-values';
import { openDatabaseAsync } from 'expo-sqlite';
import { supabase } from '../lib/supabase';
import { currentlyOnline, watchConnectivity } from './netinfo';
import { Outbox } from './outbox';
import { uuidV4 } from './sha256';
import { signedInServer } from './signedInServer';
import { openSqliteStore } from './sqliteStore';
import { fileTransport, removeSandboxFile } from './transport';

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
