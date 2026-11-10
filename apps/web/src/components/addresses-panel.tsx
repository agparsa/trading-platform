'use client';

import { cn } from '@tp/ui';
import { useAddresses, type AddressRow } from '@/lib/queries';
import { utcTime } from '@/lib/format';
import { useT } from '@/lib/use-locale';

/**
 * Where this account has been signed in from.
 *
 * One row per address, with a first and last date and what signed in from
 * it — the list a person reads when a line in the activity feed looked
 * unfamiliar. It is the answer to "have I ever been here?", which is a short
 * list of places, not a long list of mornings: the sessions list says what is
 * open now, this says where the account has been.
 *
 * The address of the request asking is marked, because "which one is me
 * right now" is the first thing anybody reading this list needs to know, and
 * making them guess is how the wrong row gets worried about.
 */
export function AddressesPanel() {
  const addresses = useAddresses();
  const rows = addresses.data ?? [];
  const t = useT();

  return (
    <div className="space-y-3" data-testid="addresses">
      <div>
        <p className="text-label uppercase tracking-wider text-terminal-muted">{t('addr.title')}</p>
        <p className="mt-1 text-caption leading-relaxed text-terminal-muted">{t('addr.lead')}</p>
      </div>

      {addresses.isPending ? (
        <p className="text-caption text-terminal-muted">{t('common.loading')}</p>
      ) : addresses.isError ? (
        <p className="text-caption text-terminal-short">{t('addr.error')}</p>
      ) : rows.length === 0 ? (
        <p className="text-caption text-terminal-muted">{t('addr.empty')}</p>
      ) : (
        <ul className="divide-y divide-terminal-border">
          {rows.map((row: AddressRow) => (
            <li key={row.ipAddress} className="flex items-start gap-3 py-2 text-caption">
              <span className="w-36 shrink-0 tabular-nums text-terminal-text">
                {row.ipAddress}
                {row.current ? (
                  <span className="ms-1 text-label text-terminal-long">{t('addr.youNow')}</span>
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-terminal-text">{row.devices.join(', ')}</span>
                <span className="text-terminal-muted">
                  {' '}
                  ·{' '}
                  {t(row.sessions === 1 ? 'addr.signInOne' : 'addr.signIns', {
                    count: row.sessions,
                  })}
                  {row.active ? ` · ${t('addr.stillOpen')}` : ''}
                </span>
              </span>
              <span
                className={cn(
                  'numeric shrink-0 whitespace-nowrap text-end text-terminal-muted',
                  row.active ? 'text-terminal-text' : '',
                )}
              >
                {row.firstSeenAt === row.lastSeenAt
                  ? utcTime(row.lastSeenAt)
                  : `${utcTime(row.firstSeenAt)} → ${utcTime(row.lastSeenAt)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
