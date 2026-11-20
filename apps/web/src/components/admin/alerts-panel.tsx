'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { Button, Field, inputClass, wordInputClass } from '@/components/primitives';
import {
  useAcknowledgeAlert,
  useAlertMetrics,
  useAlertRules,
  useDeleteAlertRule,
  useRaisedAlerts,
  useSaveAlertRule,
  type AlertRuleInput,
  type AlertRuleRow,
} from '@/lib/admin-queries';
import { relativeTime } from '@/lib/format';
import { ErrorLine, Head, Loading, Table } from './shared';

/**
 * Alerts: thresholds on counts the platform keeps — withdrawals waiting,
 * verifications waiting, mismatches open, rejections in the last hour — and
 * what crossed them.
 *
 * The worker reads every enabled rule once a minute. A rule raises when it
 * first crosses its line and again only after its quiet period while it stays
 * over, so a rule left breached does not fill the list. Raised alerts stay
 * until somebody acknowledges them, with a note if they want one.
 */
export function AlertsPanel() {
  const raised = useRaisedAlerts('open');
  const rules = useAlertRules();
  const metrics = useAlertMetrics();
  const [editing, setEditing] = useState<AlertRuleRow | 'new' | null>(null);
  const [showAll, setShowAll] = useState(false);

  const labelOf = (metric: string) =>
    metrics.data?.metrics.find((row) => row.metric === metric)?.label ?? metric;

  return (
    <div className="space-y-5 p-3" data-testid="alerts">
      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-terminal-text">
            Raised{' '}
            <span className="numeric text-terminal-muted">({raised.data?.open ?? 0} open)</span>
          </h2>
          <button
            type="button"
            className="text-caption text-terminal-muted hover:text-terminal-text"
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? 'Show open only' : 'Show acknowledged too'}
          </button>
        </div>
        <ErrorLine error={raised.error} />
        {showAll ? (
          <RaisedTable state="all" labelOf={labelOf} />
        ) : (
          <RaisedTable state="open" labelOf={labelOf} />
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-terminal-text">Rules</h2>
          {editing === null ? (
            <Button variant="neutral" onClick={() => setEditing('new')} data-testid="alerts-new">
              New rule
            </Button>
          ) : null}
        </div>
        <p className="max-w-3xl text-caption leading-relaxed text-terminal-muted">
          Read every minute. Each watches a count, never a price, so it means the same whatever the
          market is doing and does not fire because a feed went quiet.
        </p>
        {editing === null ? null : (
          <RuleEditor rule={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
        )}
        <ErrorLine error={rules.error ?? metrics.error} />
        {rules.isLoading ? (
          <Loading />
        ) : (rules.data?.rules ?? []).length === 0 ? (
          <Loading>No rules yet. Nothing is being watched for you.</Loading>
        ) : (
          <RulesTable rows={rules.data?.rules ?? []} labelOf={labelOf} onEdit={setEditing} />
        )}
      </section>
    </div>
  );
}

function RaisedTable({
  state,
  labelOf,
}: {
  state: 'open' | 'all';
  labelOf: (metric: string) => string;
}) {
  const raised = useRaisedAlerts(state);
  const ack = useAcknowledgeAlert();
  const [noting, setNoting] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const rows = raised.data?.alerts ?? [];

  if (raised.isLoading) return <Loading />;
  if (rows.length === 0) {
    return (
      <Loading>
        {state === 'open'
          ? 'Nothing raised and waiting. All clear.'
          : 'Nothing has been raised yet.'}
      </Loading>
    );
  }
  return (
    <>
      <ErrorLine error={ack.error} />
      <Table>
        <Head
          columns={[
            'Rule',
            'Watching',
            { label: 'Reading', right: true },
            'Raised',
            'State',
            { label: 'Actions', right: true },
          ]}
        />
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-terminal-border/60 align-top">
              <td className="px-2 py-1.5 font-medium text-terminal-text">{row.ruleName}</td>
              <td className="px-2 py-1.5 text-terminal-muted">{labelOf(row.metric)}</td>
              <td className="numeric px-2 py-1.5 text-end">
                <span className="text-terminal-warning">{row.value}</span>
                <span className="text-terminal-muted">
                  {' '}
                  {row.comparator === 'ABOVE' ? '>' : '<'} {row.threshold}
                </span>
              </td>
              <td className="px-2 py-1.5 text-terminal-muted" title={row.raisedAt}>
                {relativeTime(row.raisedAt)}
              </td>
              <td className="px-2 py-1.5">
                {row.acknowledgedAt === null ? (
                  <span className="rounded bg-terminal-warning/15 px-1.5 py-0.5 text-label font-medium text-terminal-warning">
                    OPEN
                  </span>
                ) : (
                  <span className="text-label text-terminal-muted">
                    Acknowledged {relativeTime(row.acknowledgedAt)}
                    {row.note === null ? null : (
                      <span className="block text-terminal-text">“{row.note}”</span>
                    )}
                  </span>
                )}
              </td>
              <td className="px-2 py-1.5 text-end">
                {row.acknowledgedAt !== null ? null : noting === row.id ? (
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    <input
                      className={cn(inputClass, 'w-56 py-1 text-xs')}
                      placeholder="Note (optional)"
                      value={note}
                      autoFocus
                      onChange={(event) => setNote(event.target.value)}
                    />
                    <Button
                      variant="neutral"
                      className="px-2 py-0.5"
                      gate={ack}
                      disabled={ack.isPending}
                      onClick={() =>
                        ack.mutate(
                          { id: row.id, note },
                          {
                            onSuccess: () => {
                              setNoting(null);
                              setNote('');
                            },
                          },
                        )
                      }
                    >
                      Acknowledge
                    </Button>
                    <Button variant="ghost" className="px-2 py-0.5" onClick={() => setNoting(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="neutral"
                    className="px-2 py-0.5"
                    gate={ack}
                    onClick={() => {
                      setNoting(row.id);
                      setNote('');
                    }}
                    data-testid="alerts-ack"
                  >
                    Acknowledge
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

function RulesTable({
  rows,
  labelOf,
  onEdit,
}: {
  rows: readonly AlertRuleRow[];
  labelOf: (metric: string) => string;
  onEdit: (row: AlertRuleRow) => void;
}) {
  const remove = useDeleteAlertRule();
  return (
    <>
      <ErrorLine error={remove.error} />
      <Table>
        <Head
          columns={[
            'Rule',
            'Raises when',
            { label: 'Now', right: true },
            'Quiet period',
            'Last raised',
            { label: 'Actions', right: true },
          ]}
        />
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-terminal-border/60">
              <td className="px-2 py-1.5">
                <span className="font-medium text-terminal-text">{row.name}</span>
                {row.enabled ? null : (
                  <span className="ms-2 text-label uppercase text-terminal-muted">off</span>
                )}
              </td>
              <td className="px-2 py-1.5 text-terminal-muted">
                {labelOf(row.metric)} {row.comparator === 'ABOVE' ? 'above' : 'below'}{' '}
                <span className="numeric text-terminal-text">{row.threshold}</span>
              </td>
              <td className="numeric px-2 py-1.5 text-end">
                {row.lastValue === null ? (
                  <span className="text-terminal-muted" title="Not read yet: within a minute">
                    —
                  </span>
                ) : (
                  <span className={row.inBreach ? 'text-terminal-warning' : 'text-terminal-text'}>
                    {row.lastValue}
                  </span>
                )}
              </td>
              <td className="px-2 py-1.5 text-terminal-muted">{minutes(row.cooldownMinutes)}</td>
              <td className="px-2 py-1.5 text-terminal-muted">
                {row.lastRaisedAt === null ? 'never' : relativeTime(row.lastRaisedAt)}
              </td>
              <td className="px-2 py-1.5 text-end">
                <div className="flex justify-end gap-1">
                  <Button variant="ghost" className="px-2 py-0.5" onClick={() => onEdit(row)}>
                    Edit
                  </Button>
                  <Button
                    variant="danger"
                    className="px-2 py-0.5"
                    gate={remove}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(row.id)}
                  >
                    Delete
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

function minutes(value: number): string {
  if (value % 1440 === 0) return `${value / 1440} day${value === 1440 ? '' : 's'}`;
  if (value % 60 === 0) return `${value / 60} hour${value === 60 ? '' : 's'}`;
  return `${value} min`;
}

const QUIET = [
  ['15 minutes', 15],
  ['1 hour', 60],
  ['4 hours', 240],
  ['1 day', 1440],
] as const;

function RuleEditor({ rule, onDone }: { rule: AlertRuleRow | null; onDone: () => void }) {
  const metrics = useAlertMetrics();
  const save = useSaveAlertRule();
  const options = metrics.data?.metrics ?? [];
  const [draft, setDraft] = useState<AlertRuleInput>({
    name: rule?.name ?? '',
    metric: rule?.metric ?? 'WITHDRAWALS_WAITING',
    comparator: rule?.comparator ?? 'ABOVE',
    threshold: rule?.threshold ?? 10,
    cooldownMinutes: rule?.cooldownMinutes ?? 60,
    enabled: rule?.enabled ?? true,
  });
  const [threshold, setThreshold] = useState(String(draft.threshold));
  const described = options.find((row) => row.metric === draft.metric);

  const problems: string[] = [];
  if (draft.name.trim() === '') problems.push('Give the rule a name.');
  if (!/^\d{1,7}$/.test(threshold)) problems.push('The threshold is a whole number.');
  if (draft.comparator === 'BELOW' && threshold === '0') {
    problems.push('A count is never below zero: that rule could never fire.');
  }

  return (
    <form
      className="space-y-3 rounded-lg border border-terminal-border bg-terminal-bg/40 p-4"
      data-testid="alerts-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (problems.length > 0) return;
        save.mutate(
          {
            ...(rule === null ? {} : { id: rule.id }),
            rule: { ...draft, name: draft.name.trim(), threshold: Number(threshold) },
          },
          { onSuccess: onDone },
        );
      }}
    >
      <h2 className="text-sm font-semibold text-terminal-text">
        {rule === null ? 'New alert rule' : `Edit ${rule.name}`}
      </h2>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name">
          <input
            className={wordInputClass}
            value={draft.name}
            maxLength={80}
            placeholder="Withdrawals piling up"
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            data-testid="alerts-name"
          />
        </Field>
        <Field label="Watch">
          <select
            className={wordInputClass}
            value={draft.metric}
            onChange={(event) => setDraft({ ...draft, metric: event.target.value })}
            data-testid="alerts-metric"
          >
            {options.map((row) => (
              <option key={row.metric} value={row.metric}>
                {row.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {described === undefined ? null : (
        <p className="-mt-1 text-label text-terminal-muted">{described.description}</p>
      )}
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Raise when it is">
          <select
            className={wordInputClass}
            value={draft.comparator}
            onChange={(event) =>
              setDraft({ ...draft, comparator: event.target.value as 'ABOVE' | 'BELOW' })
            }
          >
            <option value="ABOVE">above</option>
            <option value="BELOW">below</option>
          </select>
        </Field>
        <Field label="Threshold">
          <input
            className={inputClass}
            value={threshold}
            inputMode="numeric"
            onChange={(event) => setThreshold(event.target.value.trim())}
            data-testid="alerts-threshold"
          />
        </Field>
        <Field label="Then quiet for">
          <select
            className={wordInputClass}
            value={draft.cooldownMinutes}
            onChange={(event) =>
              setDraft({ ...draft, cooldownMinutes: Number(event.target.value) })
            }
          >
            {QUIET.map(([label, value]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
            {QUIET.some(([, value]) => value === draft.cooldownMinutes) ? null : (
              <option value={draft.cooldownMinutes}>{minutes(draft.cooldownMinutes)}</option>
            )}
          </select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-caption text-terminal-text">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
        />
        Switched on
      </label>
      {problems.length === 0 ? null : (
        <ul className="list-inside list-disc text-caption text-terminal-short" role="alert">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <ErrorLine error={save.error} />
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="neutral"
          gate={save}
          disabled={problems.length > 0 || save.isPending}
          className="border-transparent bg-terminal-accent font-medium text-terminal-bg hover:opacity-90"
          data-testid="alerts-save"
        >
          {save.isPending ? 'Saving…' : 'Save rule'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
