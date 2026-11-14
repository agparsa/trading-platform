import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpLineStream } from './http-line-stream';

function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.useRealTimers());

describe('a line-by-line HTTP stream', () => {
  it('delivers each line once, even when a line is split across chunks', async () => {
    const fetcher = vi.fn(async () => new Response(bodyOf(['{"a":1}\n{"b"', ':2}\n\n{"c":3}\n'])));
    const socket = httpLineStream('https://x', { Authorization: 'Bearer t' }, 1_000, fetcher);
    const lines: unknown[] = [];
    let opened = 0;
    let closed = 0;
    socket.onopen = () => void (opened += 1);
    socket.onmessage = (event) => void lines.push(event.data);
    socket.onclose = () => void (closed += 1);
    for (let i = 0; i < 5; i += 1) await settle();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(opened).toBe(1);
    expect(closed).toBe(1);
    expect(fetcher).toHaveBeenCalledWith(
      'https://x',
      expect.objectContaining({ headers: { Authorization: 'Bearer t' } }),
    );
  });

  it('closes on a refusal without opening', async () => {
    const socket = httpLineStream(
      'https://x',
      {},
      1_000,
      async () => new Response('no', { status: 401 }),
    );
    let opened = false;
    let closed = false;
    socket.onopen = () => void (opened = true);
    socket.onclose = () => void (closed = true);
    for (let i = 0; i < 5; i += 1) await settle();
    expect(opened).toBe(false);
    expect(closed).toBe(true);
    expect(socket.status).toBe(401);
  });

  it('closes a stream that goes quiet, so the feed reconnects', async () => {
    vi.useFakeTimers();
    const socket = httpLineStream(
      'https://x',
      {},
      20_000,
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
            },
          }),
        ),
    );
    let closed = false;
    socket.onclose = () => void (closed = true);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(closed).toBe(true);
  });
});
