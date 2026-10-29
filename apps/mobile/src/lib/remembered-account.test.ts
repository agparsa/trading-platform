import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REMEMBERED_ACCOUNT_KEY, rememberedAccount } from './remembered-account';
import type { SecureStorePort } from './token-store';

class MemoryStore implements SecureStorePort {
  readonly values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.values.set(key, value);
  }
  async remove(key: string) {
    this.values.delete(key);
  }
}

const BROKEN: SecureStorePort = {
  get: () => Promise.reject(new Error('keychain unavailable')),
  set: () => Promise.reject(new Error('keychain unavailable')),
  remove: () => Promise.reject(new Error('keychain unavailable')),
};

const ID = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f';

describe('the remembered account', () => {
  it('comes back on the next launch', async () => {
    const store = new MemoryStore();
    await rememberedAccount(store).save(ID);
    // A second instance is the next launch: nothing is held in memory.
    expect(await rememberedAccount(store).load()).toBe(ID);
  });

  it('is forgotten at sign-out', async () => {
    const store = new MemoryStore();
    const remembered = rememberedAccount(store);
    await remembered.save(ID);
    await remembered.forget();
    expect(await remembered.load()).toBeNull();
  });

  it('reads anything that is not an account id as nothing, and never writes one', async () => {
    const store = new MemoryStore();
    store.values.set(REMEMBERED_ACCOUNT_KEY, '../../admin');
    expect(await rememberedAccount(store).load()).toBeNull();
    await rememberedAccount(store).save('TP-100001');
    expect(store.values.get(REMEMBERED_ACCOUNT_KEY)).toBe('../../admin');
  });

  it('never stops the app when the keychain fails', async () => {
    const remembered = rememberedAccount(BROKEN);
    await expect(remembered.load()).resolves.toBeNull();
    await expect(remembered.save(ID)).resolves.toBeUndefined();
    await expect(remembered.forget()).resolves.toBeUndefined();
  });
});

/**
 * The module is only worth something if the screens use it. The provider is
 * a React component this suite does not render, so its wiring is read from
 * the source, as `api-root.test.ts` reads the client's base URL.
 */
describe('the wiring', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const accounts = readFileSync(resolve(here, 'accounts.tsx'), 'utf8');
  const session = readFileSync(resolve(here, 'session.tsx'), 'utf8');

  it('restores the choice when the accounts load, and saves each new one', () => {
    expect(accounts).toMatch(/remembered\.load\(\)/);
    expect(accounts).toMatch(/remembered\.save\(id\)/);
  });

  it('forgets it at sign-out', () => {
    expect(session).toMatch(/rememberedAccount\(secureStore\)\.forget\(\)/);
  });
});
