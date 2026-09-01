'use client';

import { AppShell } from '@/components/shell/app-shell';
import { Panel } from '@/components/primitives';
import { TradingSettings } from '@/components/trading-settings';
import { useTradingPreferences } from '@/lib/use-trading-preferences';

/**
 * How the terminal responds to a click and a keystroke.
 *
 * These stay reachable from the terminal's own header as well, and the badge
 * there is the reason: a terminal that will send an order on a single click has
 * to say so on screen at all times. A setting that lives only here is one the
 * trader last saw yesterday.
 */
export default function SettingsPage() {
  const { preferences, update } = useTradingPreferences();

  return (
    <AppShell
      title="Settings"
      description="One-click trading, confirmations, and default order size."
    >
      <Panel className="max-w-md p-4">
        <TradingSettings preferences={preferences} onChange={update} presentation="page" />
      </Panel>
    </AppShell>
  );
}
