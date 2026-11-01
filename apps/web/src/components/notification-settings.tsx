'use client';

import { useState } from 'react';
import { isDomainError } from '@tp/shared-types';
import { useNotificationPreferences, useUpdateNotificationCategory } from '@/lib/queries';

/** The categories' names, as a trader reads them. Same words as the phone's. */
export const NOTIFICATION_CATEGORY_LABEL: Record<string, string> = {
  TRADE_OPENED: 'Trade opened',
  TRADE_CLOSED: 'Trade closed',
  TRADE_MODIFIED: 'Trade changed',
  ORDER_FILLED: 'Order filled',
  ORDER_CANCELLED: 'Order cancelled',
  STOP_LOSS: 'Stop loss',
  TAKE_PROFIT: 'Take profit',
  RISK_ALERT: 'Risk alerts',
  PRICE_ALERT: 'Price alerts',
  SECURITY_ALERT: 'Security alerts',
  SYSTEM: 'System',
};

/**
 * What to be told about, and whether by email.
 *
 * The same server-side settings the phone edits — one record per trader,
 * not per device — so a switch turned off here is off on the phone. "Shown"
 * covers the bell and push together, as on the phone. Risk and security
 * alerts cannot be hidden: the switch is disabled and says why, rather than
 * offering an "off" the server would refuse. Email is separate, and is the
 * channel that reaches a trader with no screen open: risk alerts start on.
 */
export function NotificationSettings() {
  const preferences = useNotificationPreferences();
  const update = useUpdateNotificationCategory();
  const [error, setError] = useState<string | null>(null);

  const change = (
    category: string,
    patch: { inApp?: boolean; push?: boolean; email?: boolean },
  ) => {
    setError(null);
    update.mutate(
      { category, patch },
      {
        onError: (caught) =>
          setError(
            isDomainError(caught)
              ? caught.message
              : 'That could not be saved. Nothing was changed.',
          ),
      },
    );
  };

  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-label uppercase tracking-wider text-terminal-muted">
        Notifications
      </legend>
      {preferences.isError ? (
        <p className="text-caption text-terminal-muted">
          Your notification settings could not be loaded. They will retry.
        </p>
      ) : preferences.data === undefined ? (
        <p className="text-caption text-terminal-muted">Loading your notification settings…</p>
      ) : (
        <table className="w-full border-collapse text-xs" data-testid="notification-settings">
          <thead>
            <tr className="text-left text-label uppercase tracking-wider text-terminal-muted">
              <th className="py-1 pr-2 font-medium">About</th>
              <th className="px-2 py-1 text-center font-medium">Shown</th>
              <th className="py-1 pl-2 text-center font-medium">Email</th>
            </tr>
          </thead>
          <tbody>
            {preferences.data.categories
              .filter((row) => row.category !== 'SYSTEM')
              .map((row) => {
                const label = NOTIFICATION_CATEGORY_LABEL[row.category] ?? row.category;
                return (
                  <tr key={row.category} className="border-t border-terminal-border/60">
                    <td className="py-1.5 pr-2 text-terminal-text">
                      {label}
                      {row.unmutable ? (
                        <span className="ml-1 text-caption text-terminal-muted">
                          · always shown
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <input
                        type="checkbox"
                        aria-label={`Show ${label}`}
                        checked={row.inApp && row.push}
                        disabled={row.unmutable || update.isPending}
                        onChange={(event) =>
                          change(row.category, {
                            inApp: event.target.checked,
                            push: event.target.checked,
                          })
                        }
                      />
                    </td>
                    <td className="py-1.5 pl-2 text-center">
                      <input
                        type="checkbox"
                        aria-label={`Email ${label}`}
                        checked={row.email}
                        disabled={update.isPending}
                        onChange={(event) => change(row.category, { email: event.target.checked })}
                      />
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      )}
      {error === null ? null : (
        <p role="alert" className="text-caption text-terminal-short">
          {error}
        </p>
      )}
      <p className="text-caption text-terminal-muted">
        The same settings as the phone&apos;s. Email goes to your verified address and reaches you
        with no screen open.
      </p>
    </fieldset>
  );
}
