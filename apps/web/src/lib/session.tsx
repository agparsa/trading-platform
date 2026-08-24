'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiClient } from '@tp/api-client';

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000/api/v1';

/**
 * Where the tokens live, and why.
 *
 * The access token is held in memory only. The refresh token goes in
 * sessionStorage, so a page reload does not force a new login but closing the
 * tab does.
 *
 * This is an interim position, not the destination. sessionStorage is readable
 * by any script that gets injected into the page, so the refresh token is
 * exposed to XSS. The correct answer is an httpOnly, Secure, SameSite cookie
 * issued by the API, with CSRF protection on the mutation endpoints — that is a
 * server change and is scheduled for Phase 11 (docs/security.md). Until then the
 * exposure is real, written down, and limited to the tab's lifetime.
 */
const REFRESH_KEY = 'tp.refresh';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface SessionUser {
  id: string;
  email: string;
  role: string;
}

interface SessionValue {
  user: SessionUser | null;
  accountId: string | null;
  ready: boolean;
  api: ApiClient;
  accessToken: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

function readRefreshToken(): string | null {
  try {
    return window.sessionStorage.getItem(REFRESH_KEY);
  } catch {
    // Private browsing and locked-down profiles both throw here rather than
    // returning null, and neither is a reason to break the terminal.
    return null;
  }
}

function writeRefreshToken(token: string | null): void {
  try {
    if (token === null) window.sessionStorage.removeItem(REFRESH_KEY);
    else window.sessionStorage.setItem(REFRESH_KEY, token);
  } catch {
    /* nothing we can do; the session simply will not survive a reload */
  }
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // A ref-like holder so the client's token getter always sees the current value
  // without rebuilding the client (and its in-flight requests) on every change.
  const tokenHolder = useMemo(() => ({ current: null as string | null }), []);
  tokenHolder.current = accessToken;

  const api = useMemo(
    () =>
      new ApiClient({
        baseUrl: API_URL,
        getAccessToken: () => tokenHolder.current,
        onTokenExpired: async () => {
          const refresh = readRefreshToken();
          if (refresh === null) return null;
          try {
            const response = await fetch(`${API_URL}/auth/refresh`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ refreshToken: refresh }),
            });
            const payload = (await response.json()) as { ok: boolean; data?: TokenPair };
            if (!payload.ok || payload.data === undefined) {
              writeRefreshToken(null);
              return null;
            }
            tokenHolder.current = payload.data.accessToken;
            setAccessToken(payload.data.accessToken);
            writeRefreshToken(payload.data.refreshToken);
            return payload.data.accessToken;
          } catch {
            return null;
          }
        },
      }),
    [tokenHolder],
  );

  const loadProfile = useCallback(async () => {
    const profile = await api.get<SessionUser>('/users/me');
    setUser(profile);
    const accounts = await api.get<Array<{ id: string }>>('/accounts');
    setAccountId(accounts[0]?.id ?? null);
  }, [api]);

  // Restore a session on load by rotating the stored refresh token.
  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      const refresh = readRefreshToken();
      if (refresh === null) {
        setReady(true);
        return;
      }
      try {
        const response = await fetch(`${API_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: refresh }),
        });
        const payload = (await response.json()) as { ok: boolean; data?: TokenPair };
        if (!payload.ok || payload.data === undefined) {
          writeRefreshToken(null);
        } else if (!cancelled) {
          tokenHolder.current = payload.data.accessToken;
          setAccessToken(payload.data.accessToken);
          writeRefreshToken(payload.data.refreshToken);
          await loadProfile();
        }
      } catch {
        writeRefreshToken(null);
      } finally {
        if (!cancelled) setReady(true);
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [api, loadProfile, tokenHolder]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const pair = await api.post<TokenPair>(
        '/auth/login',
        { email, password },
        {
          idempotencyKey: crypto.randomUUID(),
        },
      );
      tokenHolder.current = pair.accessToken;
      setAccessToken(pair.accessToken);
      writeRefreshToken(pair.refreshToken);
      await loadProfile();
    },
    [api, loadProfile, tokenHolder],
  );

  const register = useCallback(
    async (email: string, password: string, displayName: string) => {
      await api.post(
        '/auth/register',
        { email, password, displayName },
        {
          idempotencyKey: crypto.randomUUID(),
        },
      );
      await signIn(email, password);
    },
    [api, signIn],
  );

  const signOut = useCallback(async () => {
    const refresh = readRefreshToken();
    if (refresh !== null) {
      await api
        .post('/auth/logout', { refreshToken: refresh }, { idempotencyKey: crypto.randomUUID() })
        .catch(() => undefined);
    }
    writeRefreshToken(null);
    tokenHolder.current = null;
    setAccessToken(null);
    setUser(null);
    setAccountId(null);
  }, [api, tokenHolder]);

  const value = useMemo<SessionValue>(
    () => ({ user, accountId, ready, api, accessToken, signIn, register, signOut }),
    [user, accountId, ready, api, accessToken, signIn, register, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside a SessionProvider');
  return value;
}
