'use client';

import { Terminal } from '@/components/terminal';
import { RequireSession } from '@/components/shell/require-session';

/**
 * The terminal.
 *
 * Deliberately not inside the `(app)` shell: it is a single dense screen where
 * every pixel of vertical space is another row of the book, and a second header
 * above it would cost that space on the one screen that cannot spare it.
 */
export default function TerminalPage() {
  return (
    <RequireSession>
      <Terminal />
    </RequireSession>
  );
}
