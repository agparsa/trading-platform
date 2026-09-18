'use client';

import { useMemo, useState } from 'react';
import { cn } from '@tp/ui';
import { Button } from '@/components/primitives';
import { useReportKinds, useReports, useRequestReport, type ReportRow } from '@/lib/admin-queries';
import { useSession } from '@/lib/session';
import { utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, Table } from './shared';

/**
 * Reports: ask for one, watch it build, fetch the file.
 *
 * ## Why this screen exists at all
 *
 * Every other export in this panel writes out *the page on screen*. That is
 * honest for a hundred rows and quietly wrong for a quarter — somebody asks for
 * "every closed trade in March", gets the fifty rows the table had paged in,
 * and has no way to tell from the file that it is not the answer. A real export
 * is minutes of query and megabytes of output, so it is a job somebody comes
 * back for, and this is where they come back to.
 *
 * ## The screen's one real job
 *
 * Saying which state a report is in, without making somebody guess. QUEUED and
 * RUNNING look the same to an impatient operator unless the screen distinguishes
 * them; FAILED has to say why in words; EXPIRED has to say that the file is gone
 * rather than that the report never existed, because those call for different
 * actions — ask again, versus ask somebody what happened.
 */
const STATUS_TEXT: Record<string, string> = {
  QUEUED: 'text-terminal-muted',
  RUNNING: 'text-terminal-warning',
  READY: 'text-terminal-long',
  FAILED: 'text-terminal-short',
  EXPIRED: 'text-terminal-muted',
};

/** What each state means, for the person deciding what to do next. */
const STATUS_MEANS: Record<string, string> = {
  QUEUED: 'Waiting for a worker.',
  RUNNING: 'Being produced now.',
  READY: 'Ready to download.',
  FAILED: 'Did not finish.',
  EXPIRED: 'Kept as long as reports are kept; the file is gone. Ask for it again.',
};

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function bytes(size: number | null): string {
  if (size === null) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function ReportsPanel() {
  const kinds = useReportKinds();
  const list = useReports();
  const request = useRequestReport();
  const { api } = useSession();

  const [kind, setKind] = useState('');
  const [from, setFrom] = useState(isoDay(-30));
  const [to, setTo] = useState(isoDay(0));
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<unknown>(null);

  const chosen = useMemo(
    () => kinds.data?.find((one) => one.kind === kind) ?? kinds.data?.[0],
    [kinds.data, kind],
  );

  /**
   * The download goes through the API client rather than a plain link.
   *
   * A link cannot carry the session header, and a report is not public — so the
   * bytes are fetched, handed to the browser as a blob, and the object URL is
   * revoked immediately. Leaving it alive keeps the whole file in memory for
   * the life of a tab that an operator leaves open all day.
   */
  async function download(report: ReportRow): Promise<void> {
    setDownloading(report.id);
    setDownloadError(null);
    try {
      const blob = await api.getBytes(`/reports/${report.id}/download`);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = report.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setDownloadError(error);
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <section className="rounded border border-terminal-border">
        <div className="border-b border-terminal-border px-3 py-2 text-xs font-medium">
          Ask for a report
        </div>
        <div className="flex flex-wrap items-end gap-3 p-3">
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-terminal-muted">
            Report
            <select
              value={chosen?.kind ?? ''}
              onChange={(event) => setKind(event.target.value)}
              className="rounded border border-terminal-border bg-terminal-raised px-2 py-1.5 text-xs text-terminal-text"
            >
              {(kinds.data ?? []).map((one) => (
                <option key={one.kind} value={one.kind}>
                  {one.title}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-terminal-muted">
            From
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="rounded border border-terminal-border bg-terminal-raised px-2 py-1.5 text-xs text-terminal-text"
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-terminal-muted">
            To
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="rounded border border-terminal-border bg-terminal-raised px-2 py-1.5 text-xs text-terminal-text"
            />
          </label>
          <Button
            disabled={chosen === undefined || request.isPending}
            onClick={() => {
              if (chosen === undefined) return;
              request.mutate({
                kind: chosen.kind,
                // The whole of the last day is wanted, not midnight at its start.
                /**
                 * The dates as picked, not UTC midnights built from them.
                 *
                 * This used to send `${from}T00:00:00.000Z`, which means a UTC
                 * day — while every other day in the platform is midnight in
                 * `TRADING_SERVER_TIMEZONE`. On a server at UTC+9 a report
                 * headed "March" began nine hours into 1 March and ran nine
                 * hours into April. The API resolves a date in the server's own
                 * timezone; the browser has no business deciding which day the
                 * trading server is having.
                 */
                from,
                to,
              });
            }}
          >
            {request.isPending ? 'Asking…' : 'Ask for it'}
          </Button>
          {chosen !== undefined ? (
            <p className="basis-full text-[11px] text-terminal-muted">{chosen.describes}</p>
          ) : null}
          {request.error !== null ? <ErrorLine error={request.error} /> : null}
        </div>
      </section>

      <section className="rounded border border-terminal-border">
        <div className="border-b border-terminal-border px-3 py-2 text-xs font-medium">
          Reports
        </div>
        {downloadError !== null ? (
          <div className="px-3 pt-2">
            <ErrorLine error={downloadError} />
          </div>
        ) : null}
        {list.isLoading ? (
          <Loading />
        ) : (list.data ?? []).length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-terminal-muted">
            No reports yet. Ask for one above; it is produced in the background and appears here.
          </p>
        ) : (
          <Table>
            <Head
              columns={[
                'Report',
                'Window',
                'Asked',
                'State',
                { label: 'Rows', right: true },
                { label: 'Size', right: true },
                '',
              ]}
            />
            <tbody>
              {(list.data ?? []).map((report) => (
                <tr key={report.id} className="border-t border-terminal-border">
                  <td className="px-2 py-1.5">{report.title}</td>
                  <td className="px-2 py-1.5 text-terminal-muted">
                    {report.params.fromMs === undefined
                      ? '—'
                      : `${new Date(report.params.fromMs).toISOString().slice(0, 10)} → ${new Date(
                          report.params.toMs ?? report.params.fromMs,
                        )
                          .toISOString()
                          .slice(0, 10)}`}
                  </td>
                  <td className="px-2 py-1.5 text-terminal-muted">{utcTime(report.requestedAt)}</td>
                  <td className="px-2 py-1.5">
                    <span className={cn('font-medium', STATUS_TEXT[report.status])}>
                      {report.status}
                    </span>
                    <span className="ml-2 text-[10px] text-terminal-muted">
                      {report.status === 'FAILED'
                        ? (report.error ?? STATUS_MEANS[report.status])
                        : STATUS_MEANS[report.status]}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {report.rowCount ?? '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{bytes(report.sizeBytes)}</td>
                  <td className="px-2 py-1.5 text-right">
                    <Button
                      variant="ghost"
                      disabled={report.status !== 'READY' || downloading === report.id}
                      onClick={() => void download(report)}
                    >
                      {downloading === report.id ? 'Fetching…' : 'Download'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
