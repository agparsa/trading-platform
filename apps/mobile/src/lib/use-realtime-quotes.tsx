import { useEffect, useMemo, useRef, useState } from 'react';
import { RealtimeClient, type ConnectionStatus, type Frame } from './realtime';
import { SeenEvents } from './seen-events';
import { apiBaseUrl } from './api';
import { useSession } from './session';

/**
 * A `quote.update` frame, which carries the same `QuoteDto` the REST endpoint
 * returns — `spread` included, so no client recomputes it.
 */
export interface LiveQuote {
  symbol: string;
  bid: string;
  ask: string;
  spread: string;
  timestamp: number;
}

/**
 * Live prices, for as long as the screen is mounted.
 *
 * The socket itself is per-hook rather than shared, which is a deliberate
 * simplification while exactly one screen streams quotes. When a second one
 * does, this becomes a provider — two sockets per app would double the server's
 * connection count for no benefit, and the server counts connections.
 */
export function useRealtimeQuotes(): {
  quotes: Record<string, LiveQuote>;
  status: ConnectionStatus;
} {
  const { accessToken } = useSession();
  const [quotes, setQuotes] = useState<Record<string, LiveQuote>>({});
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const seen = useMemo(() => new SeenEvents(200), []);
  const clientRef = useRef<RealtimeClient | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      /**
       * The access token, read through the client's own refresh path.
       *
       * A socket opened with an expired token is refused, and the failure looks
       * like a network problem. Going through `onTokenExpired` means the token
       * is renewed once, by the same deduplicating store the REST calls use.
       */
      const token = await accessToken();
      if (cancelled || token === null) {
        setStatus('idle');
        return;
      }

      const client = new RealtimeClient(apiBaseUrl(), seen);
      clientRef.current = client;
      client.connect(token, {
        onStatus: setStatus,
        onResnapshot: () => undefined,
        onFrame: (frame: Frame) => {
          if (frame.event !== 'quote.update') return;
          const quote = frame.data as LiveQuote;
          if (typeof quote?.symbol !== 'string') return;
          setQuotes((current) => ({ ...current, [quote.symbol]: quote }));
        },
      });
    })();

    return () => {
      cancelled = true;
      clientRef.current?.disconnect();
      clientRef.current = null;
    };
  }, [accessToken, seen]);

  return { quotes, status };
}
