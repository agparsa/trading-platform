import type { LiveSocket } from './live-feed.service';

/**
 * A REST quote endpoint polled on a fixed interval, behind the live-feed socket
 * interface. It is for providers whose subscription has no stream, such as
 * fastFOREX below its WebSocket plan.
 *
 * Each poll fetches every URL in turn. Every 2xx body is one `onmessage`, and
 * the first success fires `onopen`. Any failure — a refusal (401/403), the
 * rate limit (429), a 5xx or a network error — closes it after one `onerror`,
 * and `LiveFeedService` reconnects with its growing pause. A bad key or an
 * exhausted quota therefore slows to one attempt every 30 s instead of
 * hammering the provider. The headers, which carry the key, are never logged.
 * One timer at a time, and none after `close()`.
 */
export function httpPoll(
  urls: readonly string[],
  headers: Readonly<Record<string, string>>,
  intervalMs: number,
  fetcher: typeof fetch = fetch,
): LiveSocket & { lastStatus: number | null } {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let opened = false;
  let closed = false;
  const socket: LiveSocket & { lastStatus: number | null } = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    lastStatus: null,
    send: () => undefined,
    close: () => finish(),
  };
  function finish(error?: unknown): void {
    if (closed) return;
    closed = true;
    if (timer !== null) clearTimeout(timer);
    if (error !== undefined) socket.onerror?.(error);
    abort.abort();
    socket.onclose?.({});
  }

  const poll = async (): Promise<void> => {
    for (const url of urls) {
      if (closed) return;
      let response: Response;
      try {
        response = await fetcher(url, {
          headers: { ...headers },
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
        });
      } catch (error) {
        finish(error);
        return;
      }
      socket.lastStatus = response.status;
      if (!response.ok) {
        finish(new Error(`HTTP ${response.status}`));
        return;
      }
      const body = await response.text().catch(() => null);
      if (closed) return;
      if (body === null) {
        finish(new Error('body could not be read'));
        return;
      }
      if (!opened) {
        opened = true;
        socket.onopen?.({});
      }
      socket.onmessage?.({ data: body });
    }
    if (!closed) timer = setTimeout(() => void poll(), intervalMs);
  };
  queueMicrotask(() => void poll());
  return socket;
}

/**
 * Calls a month at this interval, for `calls` requests per poll (30-day month).
 * Used to refuse a configuration that would spend a provider's quota early.
 */
export function monthlyCalls(calls: number, intervalMs: number): number {
  return Math.ceil((calls * 30 * 24 * 60 * 60 * 1000) / intervalMs);
}
