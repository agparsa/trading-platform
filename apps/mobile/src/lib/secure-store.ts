import * as SecureStore from 'expo-secure-store';
import type { SecureStorePort } from './token-store';

/**
 * The device keychain.
 *
 * `expo-secure-store` wraps the iOS Keychain and Android's EncryptedSharedPreferences.
 * Deliberately not `AsyncStorage`, which is a plaintext file readable by
 * anything with access to the app's sandbox — including a backup of it.
 */
export const secureStore: SecureStorePort = {
  async get(key) {
    return SecureStore.getItemAsync(key);
  },
  async set(key, value) {
    await SecureStore.setItemAsync(key, value, {
      /**
       * Available after the first unlock, not while locked.
       *
       * A background push arriving while the phone is locked must be able to
       * read the token to fetch the position it refers to; `WHEN_UNLOCKED`
       * would fail there. `AFTER_FIRST_UNLOCK` is the weakest option that still
       * requires the device to have been unlocked since boot.
       */
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  },
  async remove(key) {
    await SecureStore.deleteItemAsync(key);
  },
};
