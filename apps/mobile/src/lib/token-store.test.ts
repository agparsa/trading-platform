import { describe, expect, it, vi } from 'vitest';
import { REFRESH_MARGIN_MS, TokenStore, type SecureStorePort, type Tokens } from './token-store';

class MemoryStore implements SecureStorePort {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const tokens = (expiresAt: number, suffix = '1'): Tokens => ({
  accessToken: `access-${suffix}`,
  refreshToken: `refresh-${suffix}`,
  accessTokenExpiresAt: expiresAt,
});

const NOW = 1_800_000_000_000;

describe('holding the session', () => {
  it('returns nothing when signed out', async () => {
    const store = new TokenStore(new MemoryStore(), async () => tokens(NOW));
    expect(await store.current()).toBeNull();
  });

  it('returns a token that is still good without refreshing', async () => {
    const refresh = vi.fn(async () => tokens(NOW + 900_000, '2'));
    const store = new TokenStore(new MemoryStore(), refresh, () => NOW);
    await store.save(tokens(NOW + 900_000));

    expect((await store.current())?.accessToken).toBe('access-1');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes before the token actually expires', async () => {
    const refresh = vi.fn(async () => tokens(NOW + 900_000, '2'));
    const store = new TokenStore(new MemoryStore(), refresh, () => NOW);
    // Still valid, but inside the margin. Waiting for real expiry means a 401
    // on whatever the trader was doing — most likely closing a position.
    await store.save(tokens(NOW + REFRESH_MARGIN_MS - 1_000));

    expect((await store.current())?.accessToken).toBe('access-2');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes exactly once when five screens ask at the same moment', async () => {
    /**
     * The deferred is created up front, not inside the executor.
     *
     * `current()` awaits before it ever calls `refresh`, so a resolver captured
     * from inside the promise body is still undefined when the test tries to
     * use it — which hangs rather than fails, and takes twenty seconds to say
     * so. Learned the slow way.
     */
    let resolveRefresh!: (value: Tokens) => void;
    const pending = new Promise<Tokens>((resolve) => {
      resolveRefresh = resolve;
    });
    const refresh = vi.fn(() => pending);
    const store = new TokenStore(new MemoryStore(), refresh, () => NOW);
    await store.save(tokens(NOW - 1));

    const all = Promise.all([
      store.current(),
      store.current(),
      store.current(),
      store.current(),
      store.current(),
    ]);
    resolveRefresh(tokens(NOW + 900_000, '2'));
    const results = await all;

    /**
     * The most important assertion in this file.
     *
     * Refresh tokens rotate. Five concurrent refreshes means four of them
     * present a token the server has already invalidated, which reads as replay
     * and logs the trader out — during the one moment they most wanted to be
     * signed in.
     */
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result?.accessToken === 'access-2')).toBe(true);
  });

  it('signs out when the refresh is refused', async () => {
    const storage = new MemoryStore();
    const store = new TokenStore(
      storage,
      async () => {
        throw new Error('revoked');
      },
      () => NOW,
    );
    await store.save(tokens(NOW - 1));

    expect(await store.current()).toBeNull();
    // Cleared, not merely reported. Leaving the tokens in place means the app
    // retries forever against a session that is over.
    expect(storage.values.size).toBe(0);
  });

  it('treats a corrupt expiry as expired rather than as forever', async () => {
    const storage = new MemoryStore();
    await storage.set('tp.access', 'access-1');
    await storage.set('tp.refresh', 'refresh-1');
    await storage.set('tp.access.expiry', 'not-a-number');

    const refresh = vi.fn(async () => tokens(NOW + 900_000, '2'));
    const store = new TokenStore(storage, refresh, () => NOW);

    expect((await store.current())?.accessToken).toBe('access-2');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('forgets everything on sign-out', async () => {
    const storage = new MemoryStore();
    const store = new TokenStore(
      storage,
      async () => tokens(NOW),
      () => NOW,
    );
    await store.save(tokens(NOW + 900_000));
    await store.clear();

    expect(storage.values.size).toBe(0);
    expect(await store.current()).toBeNull();
  });

  it('can refresh again after an earlier refresh finished', async () => {
    let issued = 1;
    const refresh = vi.fn(async () => tokens(NOW + 1_000, String(++issued)));
    let current = NOW;
    const store = new TokenStore(new MemoryStore(), refresh, () => current);
    await store.save(tokens(NOW - 1));

    expect((await store.current())?.accessToken).toBe('access-2');
    current = NOW + 2_000;
    // The in-flight guard must clear itself, or the session freezes on the
    // first token it ever refreshed.
    expect((await store.current())?.accessToken).toBe('access-3');
  });
});
