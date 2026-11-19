'use client';

import { AppShell } from '@/components/shell/app-shell';
import { Panel } from '@/components/primitives';
import { NotificationSettings } from '@/components/notification-settings';
import { ProfileSettings } from '@/components/profile-settings';
import { SoundSettings } from '@/components/sound-settings';
import { ThemeSettings } from '@/components/theme-settings';
import { TradingSettings } from '@/components/trading-settings';
import { useTradingPreferences } from '@/lib/use-trading-preferences';
import { useT } from '@/lib/use-locale';

/**
 * How the terminal responds to a click and a keystroke.
 *
 * These stay reachable from the terminal's own header as well, and the badge
 * there is the reason: a terminal that will send an order on a single click has
 * to say so on screen at all times. A setting that lives only here is one the
 * trader last saw yesterday.
 */
export default function SettingsPage() {
  const { preferences, update, oneClickAllowed } = useTradingPreferences();
  const t = useT();

  return (
    <AppShell title={t('settings.title')} description={t('settings.description')}>
      {/* Two columns where there is room: who you are and how it looks, then how it trades. */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Panel className="p-4">
            <ProfileSettings />
          </Panel>
          <Panel className="p-4">
            <ThemeSettings />
          </Panel>
          <Panel className="p-4">
            <SoundSettings />
          </Panel>
        </div>
        <div className="space-y-4">
          <Panel className="p-4">
            <TradingSettings
              preferences={preferences}
              onChange={update}
              presentation="page"
              oneClickAllowed={oneClickAllowed}
            />
          </Panel>
          <Panel className="p-4">
            <NotificationSettings />
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
