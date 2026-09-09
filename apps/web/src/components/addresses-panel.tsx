'use client';

import { cn } from '@tp/ui';
import { useAddresses, type AddressRow } from '@/lib/queries';
import { utcTime } from '@/lib/format';

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

  return (
    <div className="space-y-3" data-testid="addresses">
      <div>
        <p className="text-[10px] uppercase tracking-wider text-terminal-muted">
          Where you have signed in from
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-terminal-muted">
          Every address this account has been signed in from, for as long as sign-in records are
          kept. An address you do not recognise, with a session still open, is the one to end.
        </p>
      </div>

      {addresses.isPending ? (
        <p className="text-[11px] text-terminal-muted">Loading…</p>
      ) : addresses.isError ? (
        <p className="text-[11px] text-terminal-short">Could not load your sign-in history.</p>
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-terminal-muted">No sign-ins recorded yet.</p>
      ) : (
        <ul className="divide-y divide-terminal-border">
          {rows.map((row: AddressRow) => (
            <li key={row.ipAddress} className="flex items-start gap-3 py-2 text-[11px]">
              <span className="w-36 shrink-0 tabular-nums text-terminal-text">
                {row.ipAddress}
                {row.current ? (
                  <span className="ml-1 text-[10px] text-terminal-long">you, now</span>
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-terminal-text">{row.devices.join(', ')}</span>
                <span className="text-terminal-muted">
                  {' '}
                  · {row.sessions} {row.sessions === 1 ? 'sign-in' : 'sign-ins'}
                  {row.active ? ' · a session is still open' : ''}
                </span>
              </span>
              <span
                className={cn(
                  'w-44 shrink-0 text-right tabular-nums text-terminal-muted',
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
