import type { SecureStorePort } from './token-store';

/**
 * The browser preview's stand-in for the device keychain.
 *
 * The app ships to phones only; the web build exists so its screens can be
 * opened and checked in a browser (`scripts/preview-web.sh`). There is no
 * keychain in a browser, and `expo-secure-store` has no web implementation,
 * so the preview keeps its session in `sessionStorage` — gone when the tab
 * closes. Metro picks this file for web and `secure-store.ts` everywhere else.
 */
export const secureStore: SecureStorePort = {
  async get(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async set(key, value) {
    window.sessionStorage.setItem(key, value);
  },
  async remove(key) {
    window.sessionStorage.removeItem(key);
  },
};
