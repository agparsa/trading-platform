'use client';

import { cn } from '@tp/ui';
import { utcTime } from '@/lib/format';
import { useSecurityEvents, type SecurityEventRow } from '@/lib/queries';

const SEVERITY_TONE: Record<SecurityEventRow['severity'], string> = {
  INFO: 'text-terminal-muted',
  NOTICE: 'text-terminal-warning',
  WARNING: 'text-terminal-short',
};

/** The kinds in the words a person would use. Anything unlisted shows its code. */
const WORDING: Record<string, string> = {
  SIGN_IN: 'Signed in',
  SIGN_IN_FAILED: 'Failed sign-in attempt',
  SECOND_FACTOR_FAILED: 'Wrong second-factor code',
  SIGN_IN_NEW_DEVICE: 'Signed in from a new device',
  SIGN_OUT: 'Signed out',
  SESSION_REVOKED: 'A session was ended',
  SESSIONS_REVOKED_BY_STAFF: 'All sessions were ended by staff',
  EMAIL_VERIFIED: 'Email address verified',
  PASSWORD_CHANGED: 'Password changed',
  PASSWORD_RESET: 'Password reset',
  TWO_FACTOR_ENABLED: 'Two-factor authentication turned on',
  TWO_FACTOR_DISABLED: 'Two-factor authentication turned off',
  RECOVERY_CODE_USED: 'A recovery code was used',
  API_KEY_MINTED: 'API key created',
  API_KEY_REVOKED: 'API key revoked',
  SERVICE_TOKEN_MINTED: 'Service token created',
  SERVICE_TOKEN_REVOKED: 'Service token revoked',
  ROLE_ASSIGNED: 'Your role was changed',
  USER_SUSPENDED: 'Your account was suspended',
  USER_REINSTATED: 'Your account was reinstated',
  USER_UNLOCKED: 'Your sign-in lock was cleared',
};

/**
 * What has happened to this account, as the server recorded it.
 *
 * The list is the point: a sign-in you do not recognise, a key you did not
 * make, a password change you did not ask for. Every row is derived from the
 * audit trail and cannot be edited or removed, by you or by anybody.
 */
export function SecurityEventsPanel() {
  const events = useSecurityEvents();
  const rows = events.data?.events ?? [];

  return (
    <div className="space-y-3" data-testid="security-events">
      <div>
        <p className="text-[10px] uppercase tracking-wider text-terminal-muted">Recent activity</p>
        <p className="mt-1 text-[11px] leading-relaxed text-terminal-muted">
          Sign-ins, keys and changes to how you authenticate, as the platform recorded them. If
          something here is not you, end your sessions and change your password now.
        </p>
      </div>

      {events.isPending ? (
        <p className="text-[11px] text-terminal-muted">Loading…</p>
      ) : events.isError ? (
        <p className="text-[11px] text-terminal-short">Could not load your security activity.</p>
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-terminal-muted">Nothing recorded yet.</p>
      ) : (
        <ul className="divide-y divide-terminal-border">
          {rows.map((row) => (
            <li key={row.id} className="flex items-start gap-3 py-2 text-[11px]">
              <span className="w-32 shrink-0 tabular-nums text-terminal-muted">
                {utcTime(row.at)}
              </span>
              <span className={cn('w-16 shrink-0 font-medium', SEVERITY_TONE[row.severity])}>
                {row.severity}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-terminal-text">{WORDING[row.kind] ?? row.kind}</span>
                {row.byOther ? <span className="text-terminal-muted"> · by staff</span> : null}
                {row.ipAddress ? (
                  <span className="text-terminal-muted"> · from {row.ipAddress}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
