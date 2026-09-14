'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { inputClass } from '@/components/primitives';
import { useSecurityFeed, type AdminSecurityEventRow } from '@/lib/admin-queries';
import { utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, SeverityPill, Table } from './shared';

type Severity = '' | 'WARNING' | 'NOTICE' | 'INFO';

/**
 * The firm's security feed: every sign-in, failed sign-in, credential and
 * authentication change, for everyone, newest first. Derived from the audit
 * trail and, like it, not editable from here or anywhere.
 */
export function SecurityPanel() {
  const [severity, setSeverity] = useState<Severity>('');
  const [kind, setKind] = useState('');
  const feed = useSecurityFeed({ severity, kind: kind.trim().toUpperCase() });
  const rows = feed.data?.events ?? [];

  return (
    <div className="flex flex-col" data-testid="security-feed">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <select
          aria-label="Severity"
          className={cn(inputClass, 'w-auto py-1 text-xs')}
          value={severity}
          onChange={(event) => setSeverity(event.target.value as Severity)}
        >
          <option value="">Any severity</option>
          <option value="WARNING">Warnings</option>
          <option value="NOTICE">Notices</option>
          <option value="INFO">Info</option>
        </select>
        <input
          aria-label="Event kind"
          className={cn(inputClass, 'max-w-xs py-1 text-xs')}
          value={kind}
          placeholder="Kind, e.g. SIGN_IN_FAILED"
          onChange={(event) => setKind(event.target.value)}
        />
        <span className="ml-auto text-[10px] text-terminal-muted">
          {rows.length} {rows.length === 1 ? 'event' : 'events'}
        </span>
      </div>
      <ErrorLine error={feed.error} />
      {feed.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Loading>Nothing recorded for this filter.</Loading>
      ) : (
        <Table>
          <Head columns={['When', 'Severity', 'Kind', 'Person', 'By', 'Address', 'Request']} />
          <tbody>
            {rows.map((row: AdminSecurityEventRow) => (
              <tr key={row.id} className="border-t border-terminal-border/60 align-top">
                <td className="numeric px-3 py-1.5 text-terminal-muted">{utcTime(row.at)}</td>
                <td className="px-3 py-1.5">
                  <SeverityPill severity={row.severity} />
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-terminal-text">{row.kind}</td>
                <td className="px-3 py-1.5 text-terminal-text">
                  {row.userEmail ?? <span className="text-terminal-muted">—</span>}
                </td>
                <td className="px-3 py-1.5 text-[10px] text-terminal-muted">
                  {row.byOther ? row.actorType.toLowerCase() : 'themselves'}
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-terminal-muted">
                  {row.ipAddress ?? '—'}
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-terminal-muted">
                  {row.requestId ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
