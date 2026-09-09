import { describe, expect, it } from 'vitest';
import type { NextFunction, Response } from 'express';
import { clientAddress, requestContext, type RequestWithContext } from './request-context';
import { currentRequestScope } from './request-scope';

/**
 * The one place a request learns who is calling.
 *
 * Every session, audit row and security event records the address this
 * middleware resolves. If it resolved the proxy, all of them would say the same
 * container address and "signed in from somewhere new" could never fire — which
 * is exactly what happened before it existed.
 */

const run = (
  hops: number | undefined,
  ip: string | undefined,
  headers: Record<string, string> = {},
) => {
  const request = {
    ip,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as RequestWithContext;
  const set: Record<string, string> = {};
  const response = {
    setHeader: (k: string, v: string) => void (set[k] = v),
  } as unknown as Response;
  let scopeSeen: string | undefined;
  const next: NextFunction = () => {
    scopeSeen = currentRequestScope()?.requestId;
  };
  requestContext({ trustedProxyHops: hops })(request, response, next);
  return { request, set, scopeSeen };
};

describe('requestContext', () => {
  it('resolves the caller behind the declared proxies, once, onto the request', () => {
    const { request } = run(2, '172.16.1.1', { 'x-forwarded-for': '203.0.113.4, 10.0.0.1' });
    expect(request.client).toEqual({ address: '203.0.113.4', trusted: true });
    expect(clientAddress(request)).toBe('203.0.113.4');
  });

  /**
   * Nothing declared: the socket address is still *recorded* — a log line
   * wants the best answer available — but marked untrusted so nothing decides
   * on it.
   */
  it('records the socket address and trusts nothing when no proxies are declared', () => {
    const { request } = run(undefined, '172.16.1.1', { 'x-forwarded-for': '203.0.113.4' });
    expect(request.client).toEqual({ address: '172.16.1.1', trusted: false });
    expect(clientAddress(request)).toBe('172.16.1.1');
  });

  it('never hands out an empty address', () => {
    const { request } = run(0, undefined);
    expect(clientAddress(request)).toBeUndefined();
  });

  it('still stamps and echoes the request id, and opens the request scope', () => {
    const { request, set, scopeSeen } = run(0, '203.0.113.4');
    expect(request.requestId).toMatch(/[0-9a-f-]{36}/);
    expect(set['X-Request-Id']).toBe(request.requestId);
    expect(scopeSeen).toBe(request.requestId);
  });

  it('keeps a well-formed incoming request id and refuses an absurd one', () => {
    expect(run(0, '203.0.113.4', { 'x-request-id': 'trace-42' }).request.requestId).toBe(
      'trace-42',
    );
    expect(run(0, '203.0.113.4', { 'x-request-id': 'x'.repeat(129) }).request.requestId).not.toBe(
      'x'.repeat(129),
    );
  });
});
