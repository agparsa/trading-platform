import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PnlUpdatePayload } from '@tp/shared-types';
import { RealtimeClient, type ConnectionStatus, type Frame } from './realtime';
import { SeenEvents } from './seen-events';
import { apiBaseUrl } from './api';
import { useSession } from './session';
import { LIVE_TOPICS, NO_VERSIONS, bump, topicsOf, type LiveVersions } from './live-book';

/**
 * A `quotes.updated` frame, which carries the same `QuoteDto`s the REST endpoint
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
 * An `account.updated` frame: the valuation's figures, without the realised
 * P&L the REST snapshot adds. See `applyAccount`.
 */
export interface LiveAccountFigures {
  accountId: string;
  balance: string;
  equity: string;
  usedMargin: string;
  freeMargin: string;
  marginLevel: string | null;
  floatingPnl: string;
  updatedAt: number;
}

interface QuotesValue {
  readonly quotes: Readonly<Record<string, LiveQuote>>;
  readonly status: ConnectionStatus;
}

interface BookValue {
  readonly status: ConnectionStatus;
  /** The newest valuation of each account, by account id. */
  readonly accounts: Readonly<Record<string, LiveAccountFigures>>;
  /** The newest P&L frame of each account — every open position, marked together. */
  readonly pnl: Readonly<Record<string, readonly PnlUpdatePayload[]>>;
  /** Moves when a frame says a list changed, and on every reconnect. */
  readonly versions: LiveVersions;
}

/**
 * Two contexts, not one, because they change at different rates. Quotes move
 * up to ten times a second; a screen that only shows the book must not render
 * on every one of them.
 */
const QuotesContext = createContext<QuotesValue>({ quotes: {}, status: 'idle' });
const BookContext = createContext<BookValue>({
  status: 'idle',
  accounts: {},
  pnl: {},
  versions: NO_VERSIONS,
});

/**
 * One socket for the whole app, for as long as someone is signed in.
 *
 * It used to be opened by the market tab, for quotes, and to subscribe to the
 * private channels as well — whose frames were then discarded on arrival. The
 * home screen, the positions tab and the orders tab were fetched once and then
 * only when pulled. It lives here now, above the tabs, and every frame it is
 * sent is used: see `live-book.ts` for which are applied and which make a list
 * stale.
 *
 * ## Why sounds do not come from here
 *
 * Fills are heard through the push route (`session.tsx`), which carries the
 * server's own decision about whether this notification should make a sound.
 * A frame does not. Deduplicating the two routes against one memory would make
 * whichever arrived second a "duplicate" — and when the socket wins, which it
 * usually does, the push that knows whether to play would be the one dropped.
 * So the socket keeps its own memory, for its own duplicates.
 */
export function LiveProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { accessToken, signedIn } = useSession();
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [quotes, setQuotes] = useState<Record<string, LiveQuote>>({});
  const [accounts, setAccounts] = useState<Record<string, LiveAccountFigures>>({});
  const [pnl, setPnl] = useState<Record<string, readonly PnlUpdatePayload[]>>({});
  const [versions, setVersions] = useState<LiveVersions>(NO_VERSIONS);
  const clientRef = useRef<RealtimeClient | null>(null);

  useEffect(() => {
    if (!signedIn) {
      // The next person on this phone must not see the last one's figures.
      setStatus('idle');
      setAccounts({});
      setPnl({});
      return;
    }
    let cancelled = false;

    void (async () => {
      /**
       * The access token, read through the client's own refresh path.
       *
       * A socket opened with an expired token is refused, and the failure looks
       * like a network problem. Going through `accessToken` means the token is
       * renewed once, by the same deduplicating store the REST calls use.
       */
      const token = await accessToken();
      if (cancelled || token === null) {
        setStatus('idle');
        return;
      }

      const client = new RealtimeClient(apiBaseUrl(), new SeenEvents(200));
      clientRef.current = client;
      client.connect(token, {
        onStatus: setStatus,
        // Whatever happened while disconnected was never delivered: every list
        // is stale, and the valuations will arrive with the next tick.
        onResnapshot: () => setVersions((current) => bump(current, LIVE_TOPICS)),
        onFrame: (frame: Frame) => {
          switch (frame.event) {
            case 'quotes.updated': {
              // Conflated: one frame carries every instrument that moved.
              const moved = (frame.data as LiveQuote[]).filter(
                (q) => typeof q?.symbol === 'string',
              );
              if (moved.length === 0) return;
              setQuotes((current) => {
                const next = { ...current };
                for (const quote of moved) next[quote.symbol] = quote;
                return next;
              });
              return;
            }
            case 'account.updated': {
              const figures = frame.data as LiveAccountFigures;
              setAccounts((current) => ({ ...current, [figures.accountId]: figures }));
              return;
            }
            case 'pnl.updated': {
              if (frame.accountId === null) return;
              const accountId = frame.accountId;
              setPnl((current) => ({
                ...current,
                [accountId]: frame.data as PnlUpdatePayload[],
              }));
              return;
            }
            default:
              setVersions((current) => bump(current, topicsOf(frame.event)));
          }
        },
      });
    })();

    return () => {
      cancelled = true;
      clientRef.current?.disconnect();
      clientRef.current = null;
    };
  }, [accessToken, signedIn]);

  const quotesValue = useMemo(() => ({ quotes, status }), [quotes, status]);
  const bookValue = useMemo(
    () => ({ status, accounts, pnl, versions }),
    [status, accounts, pnl, versions],
  );

  return (
    <QuotesContext.Provider value={quotesValue}>
      <BookContext.Provider value={bookValue}>{children}</BookContext.Provider>
    </QuotesContext.Provider>
  );
}

/** Live prices, from the app's one socket. */
export function useLiveQuotes(): QuotesValue {
  return useContext(QuotesContext);
}

/** The live book: account figures, P&L, and which lists are stale. */
export function useLiveBook(): BookValue {
  return useContext(BookContext);
}
