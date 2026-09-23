import { parse, serialize } from 'cookie';
import type { Request, Response } from 'express';

/**
 * The refresh token's only home.
 *
 * Until Phase 11 the refresh token was returned in the response body and kept
 * in `sessionStorage`, where any script injected into the page could read it.
 * It is now issued **exclusively** as a cookie the browser cannot read, and the
 * whole contract lives here so there is one place to check what is actually
 * being set.
 *
 * Four attributes, each doing a job:
 *
 *   HttpOnly  — JavaScript cannot read it. This is the point of the change.
 *   SameSite  — Strict. A cross-site page cannot cause the cookie to be sent at
 *               all, which is the primary defence against CSRF on the one
 *               endpoint that authenticates by cookie.
 *   Path      — scoped to the auth routes. The cookie never rides along on a
 *               trading request, so it cannot be leaked by a proxy that logs
 *               headers on those paths, and there is no cookie present to forge
 *               a trading request with.
 *   Secure    — in production. Omitted in development because localhost is
 *               served over http and a Secure cookie would simply never be set,
 *               which fails silently and looks like a broken login.
 */
export const REFRESH_COOKIE = 'tp_refresh';

/** The auth routes are the only ones that ever need it. */
export function refreshCookiePath(globalPrefix: string, version: string): string {
  return `/${globalPrefix}/${version}/auth`.replace(/\/+/g, '/');
}

export interface CookieOptions {
  readonly path: string;
  readonly secure: boolean;
  readonly maxAgeSeconds: number;
}

export function setRefreshCookie(response: Response, token: string, options: CookieOptions): void {
  response.append(
    'Set-Cookie',
    serialize(REFRESH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: options.secure,
      path: options.path,
      maxAge: options.maxAgeSeconds,
    }),
  );
}

/**
 * Clearing must repeat every attribute that scoped the original.
 *
 * A browser matches a deletion to an existing cookie by name, path and domain;
 * a `Set-Cookie` that omits the path deletes a *different* cookie and leaves the
 * real one in place — a logout that appears to work and does not.
 */
export function clearRefreshCookie(response: Response, options: CookieOptions): void {
  response.append(
    'Set-Cookie',
    serialize(REFRESH_COOKIE, '', {
      httpOnly: true,
      sameSite: 'strict',
      secure: options.secure,
      path: options.path,
      maxAge: 0,
    }),
  );
}

export function readRefreshCookie(request: Request): string | null {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header.length === 0) return null;
  const value = parse(header)[REFRESH_COOKIE];
  return value === undefined || value === '' ? null : value;
}

/**
 * Is this request's `Origin` one we serve?
 *
 * Defence in depth behind `SameSite=Strict`, for browsers that do not honour it
 * and for the case where a future endpoint is added that authenticates by
 * cookie. A request with no `Origin` at all is not a browser form post and is
 * allowed — that is how non-browser clients and same-origin navigations arrive.
 */
export function isAllowedOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined || origin === '') return true;
  return allowed.includes(origin);
}

/**
 * Whether this response may carry the refresh token in its body.
 *
 * Only for a client that holds its own token: a native app, which keeps it in
 * the operating system's keychain. Two conditions, both required:
 *
 * - **No `Origin`.** A browser attaches one to every POST — same-origin
 *   included — and a script cannot remove it: it is a forbidden header. So a
 *   script injected into the web terminal can never meet this condition, which
 *   is the whole of what keeping the token out of bodies was for.
 * - **The client identified itself as one.** At sign-in, by sending its
 *   installation; at refresh, by presenting the old token in the body rather
 *   than as the cookie.
 *
 * Until this existed the API accepted a body token "for non-browser clients
 * that hold the value themselves" and never handed one out — so the only
 * non-browser client, the phone, could not sign in at all.
 */
export function issuesBodyRefreshToken(
  request: Request,
  identifiedAs: { installationId?: string | null } | { presentedInBody: boolean },
): boolean {
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== '') return false;
  if ('presentedInBody' in identifiedAs) return identifiedAs.presentedInBody;
  return typeof identifiedAs.installationId === 'string' && identifiedAs.installationId !== '';
}
