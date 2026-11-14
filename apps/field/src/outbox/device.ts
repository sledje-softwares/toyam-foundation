// Device identity (D43): device_id + 32-byte secret kept in secure storage; only sha256(secret) is
// sent, via register_field_device(). The secret leaves the phone only for field-drain calls.
import type { RpcClient } from './signedInServer';
import { bytesToHex, sha256Hex, uuidV4 } from './sha256';

export interface SecretStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export interface DeviceIdentity {
  device_id: string;
  secret: string;
}

const KEY = 'toyam.field.device';

export async function loadDevice(store: SecretStore): Promise<DeviceIdentity | null> {
  const raw = await store.getItem(KEY);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as DeviceIdentity;
    return typeof d.device_id === 'string' && /^[0-9a-f]{64}$/.test(d.secret) ? d : null;
  } catch {
    return null;
  }
}

/** At sign-in: create the identity if needed and register it (idempotent on the server). */
export async function ensureRegisteredDevice(
  store: SecretStore,
  client: RpcClient,
  randomBytes: (n: number) => Uint8Array,
): Promise<DeviceIdentity> {
  let d = await loadDevice(store);
  if (!d) {
    d = { device_id: uuidV4(randomBytes(16)), secret: bytesToHex(randomBytes(32)) };
    await store.setItem(KEY, JSON.stringify(d));
  }
  const { error } = await client.rpc('register_field_device', {
    p_device_id: d.device_id,
    p_secret_sha256: sha256Hex(d.secret),
    p_platform: 'android',
  });
  if (error) throw new Error(`register_field_device: ${error.code ?? ''} ${error.message ?? ''}`);
  return d;
}

/** Sign-out (when allowed) or after drain `finish`. */
export async function forgetDevice(store: SecretStore): Promise<void> {
  await store.deleteItem(KEY);
}
