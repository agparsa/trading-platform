'use client';

import type { ReactNode } from 'react';
import { RequireSession } from '@/components/shell/require-session';

/**
 * Everything that is not the terminal, the login page or the admin console.
 *
 * A route group, so the URLs stay flat — `/account`, not `/app/account`. The
 * grouping exists to share the session gate and, in each page, the shell; it is
 * not part of the address a trader is given.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <RequireSession>{children}</RequireSession>;
}
