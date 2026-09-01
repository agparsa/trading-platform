'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';

/**
 * Nothing renders until a session is known to exist.
 *
 * Written once and used by every layout, because it used to be copied into each
 * page — and a gate that is copied is a gate that is one day pasted with the
 * redirect left out. It is a redirect, not a security control: the server
 * decides on every request, and a page that rendered without a session would
 * show a screen full of refusals rather than anybody's data.
 *
 * The empty state matters. A terminal with blank numbers is indistinguishable
 * from one whose feed has died, and that is not a distinction to blur.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { ready, user } = useSession();

  useEffect(() => {
    if (ready && user === null) router.replace('/login');
  }, [ready, user, router]);

  if (!ready || user === null) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-xs text-terminal-muted">
          {ready ? 'Redirecting to sign in…' : 'Restoring session…'}
        </p>
      </main>
    );
  }

  return <>{children}</>;
}
