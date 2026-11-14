import * as aesjs from 'aes-js';
import * as SecureStore from 'expo-secure-store';
import Storage from 'expo-sqlite/kv-store';

/**
 * Supabase-recommended Expo auth storage. SecureStore values are limited to about 2 KB, a session is
 * bigger, so: a random AES-256 key lives in SecureStore (Android Keystore) and the encrypted session
 * lives in SQLite key-value storage.
 */
export class LargeSecureStore {
  private async encrypt(key: string, value: string): Promise<string> {
    const k = crypto.getRandomValues(new Uint8Array(32));
    const cipher = new aesjs.ModeOfOperation.ctr(k, new aesjs.Counter(1));
    const encrypted = cipher.encrypt(aesjs.utils.utf8.toBytes(value));
    await SecureStore.setItemAsync(key, aesjs.utils.hex.fromBytes(k));
    return aesjs.utils.hex.fromBytes(encrypted);
  }

  private async decrypt(key: string, value: string): Promise<string | null> {
    const keyHex = await SecureStore.getItemAsync(key);
    if (!keyHex) return null;
    const cipher = new aesjs.ModeOfOperation.ctr(aesjs.utils.hex.toBytes(keyHex), new aesjs.Counter(1));
    return aesjs.utils.utf8.fromBytes(cipher.decrypt(aesjs.utils.hex.toBytes(value)));
  }

  async getItem(key: string): Promise<string | null> {
    const encrypted = await Storage.getItem(key);
    return encrypted ? this.decrypt(key, encrypted) : null;
  }

  async removeItem(key: string): Promise<void> {
    await Storage.removeItem(key);
    await SecureStore.deleteItemAsync(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    await Storage.setItem(key, await this.encrypt(key, value));
  }
}
