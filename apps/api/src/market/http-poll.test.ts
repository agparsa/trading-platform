import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpPoll, monthlyCalls } from './http-poll';

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

  it('counts a month of calls', () => {
    expect(monthlyCalls(2, 6_000)).toBe(864_000);
    expect(monthlyCalls(2, 5_000)).toBe(1_036_800);
  });
});
