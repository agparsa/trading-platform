import type { ConnectionStatus } from './realtime';
import { useLiveQuotes, type LiveQuote } from './live';

export type { LiveQuote } from './live';

/**
 * Live prices, from the app's one socket (`LiveProvider`).
 *
 * This hook used to open a socket of its own. It is kept, as a name, because
 * the market tab reads it; the socket is no longer per screen.
 */
export function useRealtimeQuotes(): {
  quotes: Readonly<Record<string, LiveQuote>>;
  status: ConnectionStatus;
} {
  return useLiveQuotes();
}
