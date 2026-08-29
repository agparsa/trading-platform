'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { Button, Tabs } from '@/components/primitives';
import {
  useReconciliationFindings,
  useReconciliationRuns,
  useRequestReconciliation,
  useSetFindingStatus,
} from '@/lib/admin-queries';
import { utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, ReasonedAction, SeverityPill, Table } from './shared';

type Tab = 'findings' | 'runs';

const CLOSING = new Set(['RESOLVED', 'FALSE_POSITIVE']);

/**
 * Reconciliation, as an operator works with it.
 *
 * Two tabs, and the second is not decoration. Findings say what disagrees; runs
 * say *whether anybody checked* — and "the last run was clean" and "there has
 * been no run since Tuesday" look identical if only findings are shown. Only
 * one of them is reassuring.
 *
 * Nothing on this screen repairs anything. Correcting a discrepancy is a ledger
 * adjustment on the Accounts tab: a different permission, a second factor and a
 * reason. Keeping them apart is what stops "resolve" from quietly meaning "make
 * it go away".
 */
export function ReconciliationPanel() {
  const [tab, setTab] = useState<Tab>('findings');
  const request = useRequestReconciliation();

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-terminal-border px-3 py-2">
        <Tabs<Tab>
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'findings', label: 'Findings' },
            { id: 'runs', label: 'Runs' },
          ]}
        />
        <div className="flex items-center gap-2">
          {request.data?.alreadyRunning === true ? (
            <span className="text-[10px] text-terminal-warning">
              A run is already in flight; this one was not queued.
            </span>
          ) : null}
          <Button
            variant="neutral"
            className="px-2 py-0.5"
            disabled={request.isPending}
            onClick={() => request.mutate()}
          >
            {request.isPending ? 'Requesting…' : 'Reconcile now'}
          </Button>
        </div>
      </div>

      <ErrorLine error={request.error} />
      {tab === 'findings' ? <Findings /> : <Runs />}
    </div>
  );
}

function Findings() {
  const [status, setStatus] = useState('OPEN');
  const findings = useReconciliationFindings(status);
  const setFindingStatus = useSetFindingStatus();
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-terminal-border px-3 py-2">
        <select
          className="rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-[11px] text-terminal-text"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          aria-label="Finding status"
        >
          <option value="">Every state</option>
          <option value="OPEN">Open</option>
          <option value="ACKNOWLEDGED">Acknowledged</option>
          <option value="INVESTIGATING">Investigating</option>
          <option value="RESOLVED">Resolved</option>
          <option value="FALSE_POSITIVE">False positive</option>
        </select>
        <span className="text-[10px] text-terminal-muted">
          {findings.data === undefined ? '' : `${findings.data.length} finding(s)`}
        </span>
      </div>

      <ErrorLine error={findings.error ?? setFindingStatus.error} />

      {findings.isLoading ? (
        <Loading />
      ) : (findings.data ?? []).length === 0 ? (
        <Loading>
          {status === 'OPEN'
            ? 'Nothing is open. Check the Runs tab for when that was last verified.'
            : 'Nothing in that state.'}
        </Loading>
      ) : (
        <Table>
          <Head
            columns={[
              'Account',
              'Severity',
              'Check',
              { label: 'Seen', right: true },
              'First',
              'Last',
              'State',
              { label: 'Actions', right: true },
            ]}
          />
          <tbody>
            {(findings.data ?? []).map((row) => (
              <>
                <tr key={row.id} className="border-t border-terminal-border/60 align-top">
                  <td className="numeric px-2 py-1.5 text-terminal-text">{row.accountNumber}</td>
                  <td className="px-2 py-1.5">
                    <SeverityPill severity={row.severity} />
                  </td>
                  <td className="px-2 py-1.5 text-terminal-muted">
                    <button
                      type="button"
                      className="text-left hover:underline"
                      onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                    >
                      {row.code}
                    </button>
                  </td>
                  {/*
                    How many runs have seen it. One is new; forty is a drift that
                    has been sitting there since last month, which is a different
                    conversation.
                  */}
                  <td className="numeric px-2 py-1.5 text-right text-terminal-text">
                    {row.occurrences}
                  </td>
                  <td className="numeric px-2 py-1.5 text-terminal-muted">
                    {utcTime(row.firstSeenAt)}
                  </td>
                  <td className="numeric px-2 py-1.5 text-terminal-muted">
                    {utcTime(row.lastSeenAt)}
                  </td>
                  <td
                    className={cn(
                      'px-2 py-1.5 text-[10px] uppercase tracking-wider',
                      CLOSING.has(row.status) ? 'text-terminal-muted' : 'text-terminal-warning',
                    )}
                  >
                    {row.status}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button
                        variant="ghost"
                        className="px-2 py-0.5"
                        disabled={setFindingStatus.isPending}
                        onClick={() =>
                          setFindingStatus.mutate({
                            id: row.id,
                            status: 'INVESTIGATING',
                            note: null,
                          })
                        }
                      >
                        Investigating
                      </Button>
                      <ReasonedAction
                        label="Resolve"
                        title="What was done about it"
                        minLength={8}
                        busy={setFindingStatus.isPending}
                        onConfirm={(note) =>
                          setFindingStatus.mutate({ id: row.id, status: 'RESOLVED', note })
                        }
                      />
                      <ReasonedAction
                        label="Not a fault"
                        title="Why the records were right"
                        minLength={8}
                        busy={setFindingStatus.isPending}
                        onConfirm={(note) =>
                          setFindingStatus.mutate({ id: row.id, status: 'FALSE_POSITIVE', note })
                        }
                      />
                    </div>
                  </td>
                </tr>
                {expanded === row.id ? (
                  <tr key={`${row.id}-detail`} className="border-t border-terminal-border/60">
                    <td colSpan={8} className="bg-terminal-bg px-3 py-2">
                      <p className="mb-1 text-[11px] text-terminal-text">{row.message}</p>
                      <p className="numeric text-[10px] text-terminal-muted">
                        expected {row.expected} · actual {row.actual} · difference {row.difference}
                        {row.subjectId === null
                          ? ''
                          : ` · ${row.subjectType ?? 'row'} ${row.subjectId}`}
                      </p>
                      {row.resolutionNote === null ? null : (
                        <p className="mt-1 text-[10px] text-terminal-muted">
                          Closed: {row.resolutionNote}
                        </p>
                      )}
                    </td>
                  </tr>
                ) : null}
              </>
            ))}
          </tbody>
        </Table>
      )}

      <p className="px-3 py-2 text-[10px] text-terminal-muted">
        Resolving records that a person looked. It corrects nothing — if the drift is still there,
        the next run reopens it, which is what stops a tick put here in good faith from hiding a
        real inconsistency. Corrections are ledger entries, on the Accounts tab.
      </p>
    </>
  );
}

function Runs() {
  const runs = useReconciliationRuns();

  return (
    <>
      <ErrorLine error={runs.error} />
      {runs.isLoading ? (
        <Loading />
      ) : (runs.data ?? []).length === 0 ? (
        <Loading>Nothing has run yet.</Loading>
      ) : (
        <Table>
          <Head
            columns={[
              'Started (UTC)',
              'State',
              'How',
              { label: 'Accounts', right: true },
              { label: 'New', right: true },
              { label: 'Still there', right: true },
              { label: 'Critical', right: true },
              { label: 'Took', right: true },
            ]}
          />
          <tbody>
            {(runs.data ?? []).map((run) => (
              <tr key={run.id} className="border-t border-terminal-border/60">
                <td className="numeric px-2 py-1.5 text-terminal-muted">
                  {utcTime(run.startedAt)}
                </td>
                <td
                  className={cn(
                    'px-2 py-1.5 text-[10px] uppercase tracking-wider',
                    run.status === 'FAILED'
                      ? 'text-terminal-short'
                      : run.status === 'RUNNING'
                        ? 'text-terminal-warning'
                        : 'text-terminal-muted',
                  )}
                  title={run.error ?? undefined}
                >
                  {run.status}
                </td>
                <td className="px-2 py-1.5 text-terminal-muted">{run.trigger}</td>
                <td className="numeric px-2 py-1.5 text-right text-terminal-text">
                  {run.accountsChecked}
                </td>
                <td
                  className={cn(
                    'numeric px-2 py-1.5 text-right',
                    run.findingsRaised > 0 ? 'text-terminal-warning' : 'text-terminal-muted',
                  )}
                >
                  {run.findingsRaised}
                </td>
                <td className="numeric px-2 py-1.5 text-right text-terminal-muted">
                  {run.findingsRecurred}
                </td>
                <td
                  className={cn(
                    'numeric px-2 py-1.5 text-right',
                    run.criticalCount > 0 ? 'text-terminal-short' : 'text-terminal-muted',
                  )}
                >
                  {run.criticalCount}
                </td>
                <td className="numeric px-2 py-1.5 text-right text-terminal-muted">
                  {run.durationMs === null ? '—' : `${(run.durationMs / 1000).toFixed(1)}s`}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className="px-3 py-2 text-[10px] text-terminal-muted">
        Clean runs are listed too. &ldquo;The last run found nothing&rdquo; and &ldquo;nothing has
        run since Tuesday&rdquo; look identical without them, and only one of those is reassuring.
      </p>
    </>
  );
}
