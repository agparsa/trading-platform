'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/primitives';
import { useAuditTrail, type AuditRow } from '@/lib/admin-queries';
import { downloadCsv, toCsv } from '@/lib/csv';
import { utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, SearchBox, Table } from './shared';

/**
 * The audit trail.
 *
 * `audit.read` had been a permission that guarded nothing — there was no route
 * to read the trail at all, which is the same as not keeping one except that it
 * costs storage and creates a false sense of coverage.
 *
 * There is no way to change anything from this screen, and that is not an
 * omission. §22 asks for a trail that is immutable from the admin UI, and the
 * way to achieve that is the absence of an endpoint rather than a flag.
 */
export function AuditPanel() {
  const [action, setAction] = useState('');
  const rows = useAuditTrail(action);
  const [expanded, setExpanded] = useState<string | null>(null);

  const csv = useMemo(() => auditCsv(rows.data ?? []), [rows.data]);

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-terminal-border px-3 py-2">
        <SearchBox value={action} onChange={setAction} placeholder="Action prefix, e.g. account." />
        <span className="text-[10px] text-terminal-muted">
          {rows.data === undefined ? '' : `${rows.data.length} entries`}
        </span>
        {/*
          Built in the browser from what is already on screen, so the download is
          exactly what the operator is looking at rather than a second query that
          could return something else. A blob URL, revoked immediately: leaving
          it alive would keep the whole table in memory for the life of the tab.
        */}
        <Button
          variant="ghost"
          className="px-2 py-0.5"
          disabled={(rows.data ?? []).length === 0}
          onClick={() => downloadCsv(csv, `audit-${new Date().toISOString().slice(0, 10)}.csv`)}
        >
          Export CSV
        </Button>
      </div>

      <ErrorLine error={rows.error} />

      {rows.isLoading ? (
        <Loading />
      ) : (rows.data ?? []).length === 0 ? (
        <Loading>Nothing recorded for that filter.</Loading>
      ) : (
        <Table>
          <Head columns={['When (UTC)', 'Actor', 'As', 'Action', 'Resource', 'Address', '']} />
          <tbody>
            {(rows.data ?? []).map((row) => (
              <>
                <tr key={row.id} className="border-t border-terminal-border/60">
                  <td className="numeric px-2 py-1.5 text-terminal-muted">
                    {utcTime(row.createdAt)}
                  </td>
                  <td className="px-2 py-1.5 text-terminal-text">
                    {row.actorEmail ?? row.actorId ?? '—'}
                  </td>
                  <td className="px-2 py-1.5 text-terminal-muted">{row.actorType}</td>
                  <td className="px-2 py-1.5 text-terminal-text">{row.action}</td>
                  <td className="px-2 py-1.5 text-terminal-muted">
                    {row.resourceType}
                    {row.resourceId === null ? '' : ` ${row.resourceId.slice(0, 8)}`}
                  </td>
                  <td className="numeric px-2 py-1.5 text-terminal-muted">
                    {row.ipAddress ?? '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Button
                      variant="ghost"
                      className="px-2 py-0.5"
                      onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                    >
                      {expanded === row.id ? 'Hide' : 'Detail'}
                    </Button>
                  </td>
                </tr>
                {expanded === row.id ? (
                  <tr key={`${row.id}-detail`} className="border-t border-terminal-border/60">
                    <td colSpan={7} className="bg-terminal-bg px-3 py-2">
                      <pre className="numeric overflow-x-auto whitespace-pre-wrap text-[10px] leading-relaxed text-terminal-muted">
                        {JSON.stringify({ before: row.before, after: row.after }, null, 2)}
                      </pre>
                    </td>
                  </tr>
                ) : null}
              </>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

const AUDIT_COLUMNS = [
  'when',
  'actor',
  'actorType',
  'action',
  'resourceType',
  'resourceId',
  'ipAddress',
  'before',
  'after',
];

/**
 * The rows as CSV, built in the browser from what is already on screen.
 *
 * From the rows rather than from a second request, so the file is exactly what
 * the operator was looking at. A fresh query could return something else
 * entirely — an audit trail grows while you read it — and an export that
 * silently disagrees with the screen it came from is worse than no export.
 */
function auditCsv(rows: readonly AuditRow[]): string {
  return toCsv(
    AUDIT_COLUMNS,
    rows.map((row) => [
      row.createdAt,
      row.actorEmail ?? '',
      row.actorType,
      row.action,
      row.resourceType,
      row.resourceId ?? '',
      row.ipAddress ?? '',
      JSON.stringify(row.before ?? null),
      JSON.stringify(row.after ?? null),
    ]),
  );
}
