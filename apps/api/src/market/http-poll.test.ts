import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpPoll, monthlyCalls, refusalOf } from './http-poll';

afterEach(() => vi.useRealTimers());

describe('a polled quote endpoint', () => {
  it('fetches every URL each interval, with the key in a header, and opens once', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      async (url: string, _init?: RequestInit) => new Response(`{"u":"${url}"}`),
    );
    const socket = httpPoll(
      ['https://a', 'https://b'],
      { 'X-API-Key': 'k' },
      6_000,
      fetcher as never,
    );
    const bodies: unknown[] = [];
    let opened = 0;
    socket.onopen = () => void (opened += 1);
    socket.onmessage = (event) => void bodies.push(event.data);
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies).toEqual(['{"u":"https://a"}', '{"u":"https://b"}']);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(bodies).toHaveLength(4);
    expect(opened).toBe(1);
    expect(fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ headers: { 'X-API-Key': 'k' } }),
    );
    socket.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('closes on the rate limit or a refused key, so the feed backs off', async () => {
    for (const status of [429, 401, 403, 500]) {
      vi.useFakeTimers();
      const socket = httpPoll(
        ['https://a'],
        {},
        6_000,
        (async () => new Response('', { status })) as never,
      );
      let closed = 0;
      let errors = 0;
      socket.onclose = () => void (closed += 1);
      socket.onerror = () => void (errors += 1);
      await vi.advanceTimersByTimeAsync(0);
      expect([closed, errors, socket.lastStatus]).toEqual([1, 1, status]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(closed).toBe(1);
      vi.useRealTimers();
    }
  });

  it('spends no call while nothing it serves is in session, and resumes when one opens', async () => {
    vi.useFakeTimers();
    let open = false;
    const fetcher = vi.fn(async () => new Response('{}'));
    const socket = httpPoll(['https://a'], {}, 6_000, fetcher as never, () => open);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).not.toHaveBeenCalled();
    expect(socket.skipped).toBe(11);
    open = true;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    socket.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('counts a month of calls', () => {
    expect(monthlyCalls(2, 6_000)).toBe(864_000);
    expect(monthlyCalls(2, 5_000)).toBe(1_036_800);
  });
});

describe('a provider’s refusal, as an operator reads it', () => {
  it('carries the provider’s own reason into the error', async () => {
    vi.useFakeTimers();
    const socket = httpPoll(
      ['https://a'],
      {},
      6_000,
      (async () =>
        new Response(
          JSON.stringify({ error: 'No active subscription. Visit the console now to upgrade' }),
          { status: 401 },
        )) as never,
    );
    let said: unknown = null;
    socket.onerror = (error) => void (said = error);
    await vi.advanceTimersByTimeAsync(0);
    expect(String((said as Error).message)).toBe(
      'HTTP 401: No active subscription. Visit the console now to upgrade',
    );
    socket.close();
  });

  it('reads JSON error, message, nested message, and plain text', () => {
    expect(refusalOf('{"error":"Quota exceeded"}')).toBe('Quota exceeded');
    expect(refusalOf('{"message":"Invalid key"}')).toBe('Invalid key');
    expect(refusalOf('{"error":{"message":"Bad plan"}}')).toBe('Bad plan');
    expect(refusalOf('  Too many\n requests ')).toBe('Too many requests');
  });

  it('says nothing for an empty body, an HTML page, or JSON with no reason', () => {
    expect(refusalOf('')).toBeNull();
    expect(refusalOf('<html><body>502</body></html>')).toBeNull();
    expect(refusalOf('{"code":401}')).toBeNull();
  });

  it('never carries a credential the provider echoed back', () => {
    expect(refusalOf('{"error":"bad api_key=abc123secret"}')).toBe('bad api_key=***');
    expect(refusalOf('{"error":"key 9f8e7d6c5b4a39281706f5e4d3c2b1a0 is revoked"}')).toBe(
      'key *** is revoked',
    );
  });

  it('keeps a long reason to one short line', () => {
    expect(refusalOf(`{"error":"${'word '.repeat(60)}"}`)?.length).toBe(160);
  });
});
