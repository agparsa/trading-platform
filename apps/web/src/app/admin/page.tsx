'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AdminConsole } from '@/components/admin/admin-console';
import { useSession } from '@/lib/session';

/**
 * The administrative area.
 *
 * Gated on a session, and on nothing else. The role check that matters happens
 * on the server, for every request, from the caller's own role — so a trader
 * who types this URL sees a console whose every panel answers "your role does
 * not include this", which is exactly the truth.
 *
 * Hiding the page from them would be a courtesy, not a control, and building it
 * as though it were one is how a UI check quietly becomes the only check.
 */
export default function AdminPage() {
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

  return <AdminConsole />;
}
