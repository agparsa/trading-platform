'use client';

import { AppShell } from '@/components/shell/app-shell';
import { Panel } from '@/components/primitives';
import { SecuritySettings } from '@/components/security-settings';

/**
 * Two-factor authentication, and where this login is signed in.
 *
 * The terminal keeps the same panel behind a button in its header, because
 * ending a session you do not recognise is something you do the moment you
 * notice it, not after navigating away from your positions. This is the same
 * component; the difference is that here it has room, and an address.
 */
export default function SecurityPage() {
  return (
    <AppShell
      title="Security"
      description="Two-factor authentication, recovery codes, and the sessions signed in as you."
    >
      <Panel className="max-w-xl p-4">
        <SecuritySettings presentation="page" />
      </Panel>
    </AppShell>
  );
}
