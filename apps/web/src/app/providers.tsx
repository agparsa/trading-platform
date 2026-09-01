'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isWorthRetrying } from '@tp/api-client';
import { SessionProvider } from '@/lib/session';

/**
 * Client-side providers.
 *
 * The QueryClient is created in state rather than at module scope so that each
 * browser session gets its own cache — a module-level client is shared across
 * requests when Next renders on the server, which would leak one user's
 * positions into another's first paint.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Trading state changes because the market moved or an order filled,
            // and both arrive over the socket. Refetching on an interval would
            // be guessing.
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
            staleTime: 10_000,
            /**
             * A refusal is an answer. Retrying it is not.
             *
             * `retry: 1` retried everything, including a refusal — so a support
             * user who opened an administrative page watched "Loading…" while
             * the browser asked again and was refused again, and only then saw
             * why. See `isWorthRetrying`, which draws the line, and which exists
             * because opening the page is what found this.
             */
            retry: (failureCount, error) => failureCount < 1 && isWorthRetrying(error),
          },
          mutations: {
            // A failed order is a decision for the trader, not something to
            // retry silently behind their back.
            retry: 0,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>{children}</SessionProvider>
    </QueryClientProvider>
  );
}
