import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import {
  clearRefreshCookie,
  isAllowedOrigin,
  readRefreshCookie,
  refreshCookiePath,
  REFRESH_COOKIE,
  setRefreshCookie,
} from './refresh-cookie';

/**
 * The refresh cookie's attributes are the security control, not decoration.
 * Each one is asserted by name here, because a cookie that lost `HttpOnly` in a
 * refactor would keep working perfectly and quietly undo Phase 11.
 */

const options = { path: '/api/v1/auth', secure: true, maxAgeSeconds: 2_592_000 };

function fakeResponse(): Response & { headers: string[] } {
  const headers: string[] = [];
  return {
    headers,
    append: (_name: string, value: string) => headers.push(value),
  } as unknown as Response & { headers: string[] };
}

const requestWith = (cookie?: string): Request =>
  ({ headers: cookie === undefined ? {} : { cookie } }) as unknown as Request;

describe('setRefreshCookie', () => {
  it('marks the cookie HttpOnly, so no script can read it', () => {
    const response = fakeResponse();
    setRefreshCookie(response, 'token-value', options);
    expect(response.headers[0]).toContain('HttpOnly');
  });

  /** SameSite=Strict is the primary CSRF defence on the one cookie-authenticated route. */
  it('marks the cookie SameSite=Strict', () => {
    const response = fakeResponse();
    setRefreshCookie(response, 'token-value', options);
    expect(response.headers[0]).toMatch(/SameSite=Strict/i);
  });

  /**
   * Path scoping keeps the cookie off every trading request, so it cannot be
   * logged by a proxy on those paths and there is nothing to forge one with.
   */
  it('scopes the cookie to the auth routes', () => {
    const response = fakeResponse();
    setRefreshCookie(response, 'token-value', options);
    expect(response.headers[0]).toContain('Path=/api/v1/auth');
  });

  it('sets Secure when told to', () => {
    const response = fakeResponse();
    setRefreshCookie(response, 'token-value', options);
    expect(response.headers[0]).toContain('Secure');
  });

  /**
   * And not otherwise. A Secure cookie is simply never stored over plain http,
   * which in development fails silently and looks like a broken login.
   */
  it('omits Secure in development', () => {
    const response = fakeResponse();
    setRefreshCookie(response, 'token-value', { ...options, secure: false });
    expect(response.headers[0]).not.toContain('Secure');
  });

  it('carries the token value', () => {
    const response = fakeResponse();
    setRefreshCookie(response, 'token-value', options);
    expect(response.headers[0]).toContain(`${REFRESH_COOKIE}=token-value`);
  });
});

describe('clearRefreshCookie', () => {
  /**
   * A browser matches a deletion by name, path and domain. A `Set-Cookie` that
   * omits the path deletes a different cookie and leaves the real one in place —
   * a logout that appears to work and does not.
   */
  it('repeats the path, so the browser matches the cookie it is deleting', () => {
    const response = fakeResponse();
    clearRefreshCookie(response, options);
    expect(response.headers[0]).toContain('Path=/api/v1/auth');
  });

  it('expires it immediately and empties the value', () => {
    const response = fakeResponse();
    clearRefreshCookie(response, options);
    expect(response.headers[0]).toContain('Max-Age=0');
    expect(response.headers[0]).toContain(`${REFRESH_COOKIE}=;`);
  });

  it('keeps HttpOnly on the deletion, so it cannot be overwritten from script', () => {
    const response = fakeResponse();
    clearRefreshCookie(response, options);
    expect(response.headers[0]).toContain('HttpOnly');
  });
});

describe('readRefreshCookie', () => {
  it('finds the token among other cookies', () => {
    const request = requestWith(`theme=dark; ${REFRESH_COOKIE}=abc123; locale=en`);
    expect(readRefreshCookie(request)).toBe('abc123');
  });

  it('returns null when there is no cookie header at all', () => {
    expect(readRefreshCookie(requestWith())).toBeNull();
  });

  it('returns null for a cleared cookie rather than an empty string', () => {
    // An empty value is a cookie being deleted, not a token. Returning '' would
    // send it on to be verified and produce a confusing failure.
    expect(readRefreshCookie(requestWith(`${REFRESH_COOKIE}=`))).toBeNull();
  });

  it('ignores a different cookie with a similar name', () => {
    expect(readRefreshCookie(requestWith(`${REFRESH_COOKIE}_old=abc`))).toBeNull();
  });
});

describe('isAllowedOrigin', () => {
  const allowed = ['http://localhost:3000', 'https://app.example.com'];

  it('allows an origin we serve', () => {
    expect(isAllowedOrigin('https://app.example.com', allowed)).toBe(true);
  });

  it('refuses one we do not', () => {
    expect(isAllowedOrigin('https://evil.example.com', allowed)).toBe(false);
  });

  /**
   * A request with no Origin is not a cross-site form post — that is how
   * non-browser clients and same-origin navigations arrive. Refusing them would
   * break every API client to defend against something they cannot do.
   */
  it('allows a request with no Origin at all', () => {
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
    expect(isAllowedOrigin('', allowed)).toBe(true);
  });

  it('does not match on a prefix', () => {
    expect(isAllowedOrigin('https://app.example.com.evil.test', allowed)).toBe(false);
  });
});

describe('refreshCookiePath', () => {
  it('derives the path from the configured prefix and version', () => {
    expect(refreshCookiePath('api', 'v1')).toBe('/api/v1/auth');
  });

  it('collapses a prefix that already carries slashes', () => {
    expect(refreshCookiePath('/api/', 'v1')).toBe('/api/v1/auth');
  });
});
