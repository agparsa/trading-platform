'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiClient } from '@tp/api-client';

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000/api/v1';

/**
 * Where the tokens live, and why.
 *
 * The access token is held in memory. The refresh token is **not held here at
 * all** — the API issues it as an httpOnly, SameSite=Strict cookie scoped to the
 * auth routes, and this code never sees its value. A script injected into the
 * page cannot read what the browser will not hand over.
 *
 * That is the whole of the Phase 11 change. Before it, the refresh token was
 * returned in the login response and kept in `sessionStorage`, where any XSS
 * could take it and mint access tokens for a month.
 *
 * The consequences are visible in what is *missing* below: no storage reads, no
 * storage writes, no try/catch around a private-browsing exception, and no token
 * threaded through the refresh call. There is only `credentials: 'include'`.
 */

interface AuthTokens {
  accessToken: string;
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

/**
 * Rotate the refresh cookie for a fresh access token.
 *
 * Raw `fetch` rather than the API client, because this is the one call that must
 * not be retried by the client's own token-expiry handler — a refresh that
 * failed and then triggered a refresh would loop.
 */
async function rotate(): Promise<AuthTokens | null> {
  try {
    const response = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: '{}',
    });
    const payload = (await response.json()) as { ok: boolean; data?: AuthTokens };
    return payload.ok && payload.data !== undefined ? payload.data : null;
  } catch {
    // Offline, or the API is down. Neither is a signed-out session; the caller
    // decides, and the cookie is still there for the next attempt.
    return null;
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
        // The refresh cookie is path-scoped to /auth, so this does not attach it
        // to a trading request.
        credentials: 'include',
        getAccessToken: () => tokenHolder.current,
        onTokenExpired: async () => {
          const tokens = await rotate();
          if (tokens === null) return null;
          tokenHolder.current = tokens.accessToken;
          setAccessToken(tokens.accessToken);
          return tokens.accessToken;
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

  // Restore a session on load. There is nothing to read first: if the cookie is
  // there the rotation succeeds, and if it is not the user is signed out.
  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      const tokens = await rotate();
      if (tokens !== null && !cancelled) {
        tokenHolder.current = tokens.accessToken;
        setAccessToken(tokens.accessToken);
        await loadProfile().catch(() => undefined);
      }
      if (!cancelled) setReady(true);
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [loadProfile, tokenHolder]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const tokens = await api.post<AuthTokens>(
        '/auth/login',
        { email, password },
        { idempotencyKey: crypto.randomUUID() },
      );
      tokenHolder.current = tokens.accessToken;
      setAccessToken(tokens.accessToken);
      await loadProfile();
    },
    [api, loadProfile, tokenHolder],
  );

  const register = useCallback(
    async (email: string, password: string, displayName: string) => {
      await api.post(
        '/auth/register',
        { email, password, displayName },
        { idempotencyKey: crypto.randomUUID() },
      );
      await signIn(email, password);
    },
    [api, signIn],
  );

  const signOut = useCallback(async () => {
    // The server clears the cookie and revokes the family; the client only has
    // to forget the access token it holds in memory.
    await api
      .post('/auth/logout', {}, { idempotencyKey: crypto.randomUUID() })
      .catch(() => undefined);
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
