import { describe, expect, it, vi } from 'vitest';
import { DomainError, IDEMPOTENCY_HEADER, TradingErrorCode } from '@tp/shared-types';
import { ApiClient } from './http';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const client = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  new ApiClient({ baseUrl: 'https://api.test/api/v1', fetchImpl, ...extra });

describe('ApiClient', () => {
  it('unwraps a success envelope', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, data: { balance: '99882.03' } }));
    const result = await client(fetchImpl as unknown as typeof fetch).get<{ balance: string }>(
      '/accounts/me',
    );
    expect(result.balance).toBe('99882.03');
  });

  it('turns a failure envelope into a DomainError carrying the code', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          ok: false,
          error: {
            code: TradingErrorCode.INSUFFICIENT_MARGIN,
            message: 'Insufficient free margin',
            requestId: 'req-1',
          },
        },
        422,
      ),
    );
    await expect(
      client(fetchImpl as unknown as typeof fetch).post('/orders', {}, { idempotencyKey: 'k1' }),
    ).rejects.toMatchObject({ code: TradingErrorCode.INSUFFICIENT_MARGIN });
  });

  it('sends the idempotency key on every mutation', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, data: null }));
    await client(fetchImpl as unknown as typeof fetch).post(
      '/orders',
      { volume: '1' },
      { idempotencyKey: 'abc-123' },
    );
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)[IDEMPOTENCY_HEADER]).toBe('abc-123');
  });

  it('attaches a bearer token when one is available', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, data: null }));
    await client(fetchImpl as unknown as typeof fetch, { getAccessToken: () => 'tok' }).get(
      '/accounts/me',
    );
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
  });

  it('retries once after refreshing an expired token', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1
        ? jsonResponse(
            {
              ok: false,
              error: { code: TradingErrorCode.TOKEN_EXPIRED, message: 'expired', requestId: 'r' },
            },
            401,
          )
        : jsonResponse({ ok: true, data: { fresh: true } });
    });
    const onTokenExpired = vi.fn(async () => 'new-token');
    const result = await client(fetchImpl as unknown as typeof fetch, { onTokenExpired }).get<{
      fresh: boolean;
    }>('/accounts/me');
    expect(result.fresh).toBe(true);
    expect(onTokenExpired).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports an unreadable response as an internal error, not as success', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>502</html>', { status: 502 }));
    await expect(
      client(fetchImpl as unknown as typeof fetch).get('/accounts/me'),
    ).rejects.toMatchObject({
      code: TradingErrorCode.INTERNAL_ERROR,
    });
  });

  /**
   * 204 is a success with nothing to say, and the body is empty by definition.
   * Before this was handled, every endpoint that answers 204 — sign out, disable
   * two-factor, end a session — threw "the server returned an unreadable
   * response" *after the server had done the thing*. It went unnoticed because
   * the only caller at the time swallowed its errors.
   */
  it('treats 204 as success rather than as an unreadable response', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(
      client(fetchImpl as unknown as typeof fetch).delete('/auth/sessions/abc', {
        idempotencyKey: 'k',
      }),
    ).resolves.toBeUndefined();
  });

  it('still reports an empty body with a success status as unreadable', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await expect(
      client(fetchImpl as unknown as typeof fetch).get('/accounts/me'),
    ).rejects.toMatchObject({ code: TradingErrorCode.INTERNAL_ERROR });
  });

  it('reports a network failure as service unavailable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      client(fetchImpl as unknown as typeof fetch).get('/accounts/me'),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('serialises query parameters and skips undefined ones', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, data: [] }));
    await client(fetchImpl as unknown as typeof fetch).get('/trades', {
      query: { limit: 50, cursor: undefined, symbol: 'XAUUSD' },
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.test/api/v1/trades?limit=50&symbol=XAUUSD',
    );
  });
});
