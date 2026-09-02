'use client';

import { AppShell } from '@/components/shell/app-shell';
import { Panel } from '@/components/primitives';
import { SecuritySettings } from '@/components/security-settings';
import { ApiKeysPanel } from '@/components/api-keys-panel';

/**
 * Two-factor authentication, where this login is signed in, and the keys
 * that act as you without signing in.
 *
 * The terminal keeps the first panel behind a button in its header, because
 * ending a session you do not recognise is something you do the moment you
 * notice it, not after navigating away from your positions. This is the same
 * component; the difference is that here it has room, and an address. API
 * keys live beside it because they are the same question — what can act as
 * me right now — asked about scripts rather than browsers.
 */
export default function SecurityPage() {
  return (
    <AppShell
      title="Security"
      description="Two-factor authentication, recovery codes, the sessions signed in as you, and the API keys that act as you."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="p-4">
          <SecuritySettings presentation="page" />
        </Panel>
        <Panel className="p-4">
          <ApiKeysPanel />
        </Panel>
      </div>
    </AppShell>
  );
}
