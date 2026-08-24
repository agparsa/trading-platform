'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Terminal } from '@/components/terminal';
import { useSession } from '@/lib/session';

/**
 * The terminal, gated on a session.
 *
 * While the session is being restored the page shows nothing rather than an
 * empty terminal: a terminal with blank numbers is indistinguishable from one
 * whose feed has died, and that is not a distinction to blur.
 */
export default function TerminalPage() {
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

  return <Terminal />;
}
