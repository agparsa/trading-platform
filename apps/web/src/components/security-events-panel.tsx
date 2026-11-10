'use client';

import { cn } from '@tp/ui';
import { utcTime } from '@/lib/format';
import { useSecurityEvents, type SecurityEventRow } from '@/lib/queries';
import { wordsFor, type MessageKey } from '@/lib/messages';
import { useT } from '@/lib/use-locale';

const SEVERITY_TONE: Record<SecurityEventRow['severity'], string> = {
  INFO: 'text-terminal-muted',
  NOTICE: 'text-terminal-warning',
  WARNING: 'text-terminal-short',
};

const SEVERITY_WORDS: Record<SecurityEventRow['severity'], MessageKey> = {
  INFO: 'secev.severity.INFO',
  NOTICE: 'secev.severity.NOTICE',
  WARNING: 'secev.severity.WARNING',
};

/** The kinds in the words a person would use. Anything unlisted shows its code. */
const WORDING: Record<string, MessageKey> = {
  SIGN_IN: 'secev.kind.SIGN_IN',
  SIGN_IN_FAILED: 'secev.kind.SIGN_IN_FAILED',
  SECOND_FACTOR_FAILED: 'secev.kind.SECOND_FACTOR_FAILED',
  SIGN_IN_NEW_DEVICE: 'secev.kind.SIGN_IN_NEW_DEVICE',
  SIGN_OUT: 'secev.kind.SIGN_OUT',
  SESSION_REVOKED: 'secev.kind.SESSION_REVOKED',
  SESSIONS_REVOKED_BY_STAFF: 'secev.kind.SESSIONS_REVOKED_BY_STAFF',
  EMAIL_VERIFIED: 'secev.kind.EMAIL_VERIFIED',
  PASSWORD_CHANGED: 'secev.kind.PASSWORD_CHANGED',
  PASSWORD_RESET: 'secev.kind.PASSWORD_RESET',
  TWO_FACTOR_ENABLED: 'secev.kind.TWO_FACTOR_ENABLED',
  TWO_FACTOR_DISABLED: 'secev.kind.TWO_FACTOR_DISABLED',
  RECOVERY_CODE_USED: 'secev.kind.RECOVERY_CODE_USED',
  API_KEY_MINTED: 'secev.kind.API_KEY_MINTED',
  API_KEY_REVOKED: 'secev.kind.API_KEY_REVOKED',
  SERVICE_TOKEN_MINTED: 'secev.kind.SERVICE_TOKEN_MINTED',
  SERVICE_TOKEN_REVOKED: 'secev.kind.SERVICE_TOKEN_REVOKED',
  ROLE_ASSIGNED: 'secev.kind.ROLE_ASSIGNED',
  USER_SUSPENDED: 'secev.kind.USER_SUSPENDED',
  USER_REINSTATED: 'secev.kind.USER_REINSTATED',
  USER_UNLOCKED: 'secev.kind.USER_UNLOCKED',
  BREAK_GLASS_OPENED: 'secev.kind.BREAK_GLASS_OPENED',
  BREAK_GLASS_CLOSED: 'secev.kind.BREAK_GLASS_CLOSED',
  IP_RULE_CHANGED: 'secev.kind.IP_RULE_CHANGED',
  // The five device events were recorded from the day devices were, and shown
  // here as their raw names — including DEVICE_REGISTERED, a WARNING, which is
  // the one a person is meant to recognise as not theirs. Found by
  // `client-vocabularies.test.ts`, which holds this list to the enum.
  DEVICE_REGISTERED: 'secev.kind.DEVICE_REGISTERED',
  DEVICE_REVIVED: 'secev.kind.DEVICE_REVIVED',
  DEVICE_REVOKED: 'secev.kind.DEVICE_REVOKED',
  DEVICE_REVOKED_BY_STAFF: 'secev.kind.DEVICE_REVOKED_BY_STAFF',
  DEVICE_RESTORED_BY_STAFF: 'secev.kind.DEVICE_RESTORED_BY_STAFF',
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
  const t = useT();

  return (
    <div className="space-y-3" data-testid="security-events">
      <div>
        <p className="text-label uppercase tracking-wider text-terminal-muted">
          {t('secev.title')}
        </p>
        <p className="mt-1 text-caption leading-relaxed text-terminal-muted">{t('secev.lead')}</p>
      </div>

      {events.isPending ? (
        <p className="text-caption text-terminal-muted">{t('common.loading')}</p>
      ) : events.isError ? (
        <p className="text-caption text-terminal-short">{t('secev.error')}</p>
      ) : rows.length === 0 ? (
        <p className="text-caption text-terminal-muted">{t('secev.empty')}</p>
      ) : (
        <ul className="divide-y divide-terminal-border">
          {rows.map((row) => (
            <li key={row.id} className="flex items-start gap-3 py-2 text-caption">
              <span className="w-32 shrink-0 tabular-nums text-terminal-muted">
                {utcTime(row.at)}
              </span>
              <span className={cn('w-16 shrink-0 font-medium', SEVERITY_TONE[row.severity])}>
                {t(SEVERITY_WORDS[row.severity])}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-terminal-text">{wordsFor(WORDING, row.kind, t)}</span>
                {row.byOther ? (
                  <span className="text-terminal-muted"> · {t('secev.byStaff')}</span>
                ) : null}
                {row.ipAddress ? (
                  <span className="text-terminal-muted">
                    {' '}
                    · {t('secev.from', { ip: row.ipAddress })}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
