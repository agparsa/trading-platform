'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
            retry: 1,
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
