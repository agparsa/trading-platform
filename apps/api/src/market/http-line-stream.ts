import type { LiveSocket } from './live-feed.service';

/** No byte for this long and the stream is presumed dead (OANDA beats every 5 s). */
export const STREAM_IDLE_MS = 20_000;

/**
 * A long-lived HTTP response read line by line, behind the same small socket
 * interface the WebSocket feeds use — so the reconnecting, throttling and
 * ingest in `LiveFeedService` are the same code for both.
 *
 * `onopen` when the server answers 2xx; `onmessage` once per non-empty line;
 * `onclose` once, whether the response ended, failed, was refused (non-2xx,
 * logged by status only) or went quiet for `idleMs`. `close()` aborts. The
 * headers — which carry the token — are never logged or exposed.
 */
export function httpLineStream(
  url: string,
  headers: Readonly<Record<string, string>>,
  idleMs: number = STREAM_IDLE_MS,
  fetcher: typeof fetch = fetch,
): LiveSocket & { status: number | null } {
  const abort = new AbortController();
  let closed = false;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const socket: LiveSocket & { status: number | null } = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    status: null,
    send: () => undefined,
    close: () => {
      abort.abort();
    },
  };
  const finish = (error?: unknown) => {
    if (closed) return;
    closed = true;
    if (idle !== null) clearTimeout(idle);
    if (error !== undefined && !abort.signal.aborted) socket.onerror?.(error);
    abort.abort();
    socket.onclose?.({});
  };
  const watch = () => {
    if (idle !== null) clearTimeout(idle);
    idle = setTimeout(() => finish(new Error('stream went quiet')), idleMs);
  };

  void (async () => {
    try {
      watch();
      const response = await fetcher(url, { headers: { ...headers }, signal: abort.signal });
      socket.status = response.status;
      if (!response.ok || response.body === null) {
        finish(new Error(`HTTP ${response.status}`));
        return;
      }
      socket.onopen?.({});
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        watch();
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf('\n');
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line !== '') socket.onmessage?.({ data: line });
          newline = buffered.indexOf('\n');
        }
      }
      finish();
    } catch (error) {
      finish(error);
    }
  })();

  return socket;
}
