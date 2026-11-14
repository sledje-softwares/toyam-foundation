import * as SecureStore from 'expo-secure-store';
import type { SecretStore } from '../outbox/device';

/** Android Keystore-backed storage for the device secret (small values only). */
export const secretStore: SecretStore = {
  getItem: (k) => SecureStore.getItemAsync(k),
  setItem: (k, v) => SecureStore.setItemAsync(k, v),
  deleteItem: (k) => SecureStore.deleteItemAsync(k),
};
