import type { SecureStorePort } from './token-store';

/**
 * The account the trader last chose, kept across launches.
 *
 * Kept in the keychain (`secureStore`) because it is the one store this app
 * has, and adding a second native module to hold one id is a dependency for
 * nothing. An account id is not a secret, and the keychain does not make it
 * one; it is simply where the app can write.
 *
 * Two rules make it safe to trust on the next launch:
 *
 * - **It is only a request.** `resolveSelection` still decides, against the
 *   list the server returns: an account that was closed, or belongs to
 *   whoever signed in before, falls back to the first rather than being sent.
 * - **It never stops the app.** A keychain that throws — locked, corrupted,
 *   restored from another device — reads as "nothing remembered". Losing a
 *   preference is a nuisance; an app that will not open over one is a fault.
 *
 * Sign-out forgets it, like the tokens: the next person on this phone starts
 * from their own first account, not from an id of the last person's.
 */
export const REMEMBERED_ACCOUNT_KEY = 'tp.account.selected';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RememberedAccount {
  load(): Promise<string | null>;
  save(accountId: string): Promise<void>;
  forget(): Promise<void>;
}

export function rememberedAccount(store: SecureStorePort): RememberedAccount {
  return {
    async load() {
      try {
        const value = await store.get(REMEMBERED_ACCOUNT_KEY);
        // Anything that is not an id is not one: read as nothing, not sent.
        return value !== null && UUID.test(value) ? value : null;
      } catch {
        return null;
      }
    },
    async save(accountId) {
      if (!UUID.test(accountId)) return;
      try {
        await store.set(REMEMBERED_ACCOUNT_KEY, accountId);
      } catch {
        // The choice still holds for this launch; only the memory of it is lost.
      }
    },
    async forget() {
      try {
        await store.remove(REMEMBERED_ACCOUNT_KEY);
      } catch {
        // Nothing to do: a value that cannot be removed is still only a request.
      }
    },
  };
}
