'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { cn } from '@tp/ui';
import { Button, Field, inputClass, wordInputClass } from '@/components/primitives';
import {
  useAdminInstruments,
  useDeleteFeeSchedule,
  useFeeReport,
  useFeeSchedules,
  useSaveFeeSchedule,
  type FeeScheduleInput,
  type FeeScheduleRow,
} from '@/lib/admin-queries';
import { utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, Table } from './shared';

const RATE = /^\d{1,18}(\.\d{1,10})?$/;

/**
 * Fees: the commission schedules accounts can be put on, and what fees came to.
 *
 * A schedule replaces the commission an account pays — per instrument, with a
 * default for the rest — and nothing else: swap and margin stay the
 * instrument's. Accounts go on a schedule from their own page, with a reason.
 * The report reads the ledger, so it is what was actually charged, never a
 * recomputation from today's rates.
 */
export function FeesPanel() {
  const [tab, setTab] = useState<'schedules' | 'report'>('schedules');
  return (
    <div className="flex flex-col" data-testid="fees">
      <div
        role="tablist"
        aria-label="Fees"
        className="flex gap-1 border-b border-terminal-border px-3 py-1.5"
      >
        {(
          [
            ['schedules', 'Commission schedules'],
            ['report', 'Fees charged'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              'rounded px-2.5 py-1 text-caption transition-colors',
              tab === id
                ? 'bg-terminal-raised text-terminal-text'
                : 'text-terminal-muted hover:text-terminal-text',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'schedules' ? <Schedules /> : <Report />}
    </div>
  );
}

function Schedules() {
  const schedules = useFeeSchedules();
  const remove = useDeleteFeeSchedule();
  const [editing, setEditing] = useState<FeeScheduleRow | 'new' | null>(null);

  if (schedules.isLoading) return <Loading />;
  const rows = schedules.data?.schedules ?? [];

  return (
    <div className="space-y-3 p-3">
      <p className="max-w-3xl text-caption leading-relaxed text-terminal-muted">
        A schedule sets the commission per lot, per leg, that the accounts on it pay — by
        instrument, and a default for instruments it does not list. An account on no schedule pays
        the instrument’s own rate (Instruments). Changes apply from each account’s next order; what
        was already charged stays charged. Put an account on a schedule from its page under
        Accounts.
      </p>
      <ErrorLine error={schedules.error ?? remove.error} />
      {editing === null ? (
        <Button
          variant="neutral"
          gate={remove}
          onClick={() => setEditing('new')}
          data-testid="fees-new"
        >
          New schedule
        </Button>
      ) : (
        <ScheduleEditor
          schedule={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      )}
      {rows.length === 0 ? (
        <Loading>No schedules yet: every account pays the instruments’ own rates.</Loading>
      ) : (
        <Table>
          <Head
            columns={[
              'Schedule',
              { label: 'Default / lot', right: true },
              'Instrument rates',
              { label: 'Accounts', right: true },
              'Changed',
              { label: 'Actions', right: true },
            ]}
          />
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-terminal-border/60 align-top">
                <td className="px-2 py-1.5">
                  <span className="font-medium text-terminal-text">{row.name}</span>
                  {row.note === null ? null : (
                    <span className="block text-label text-terminal-muted">{row.note}</span>
                  )}
                </td>
                <td className="numeric px-2 py-1.5 text-end text-terminal-text">
                  {row.defaultCommissionPerLot ?? (
                    <span className="text-terminal-muted">instrument’s</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-terminal-muted">
                  {row.rules.length === 0
                    ? '—'
                    : row.rules.map((rule) => (
                        <span key={rule.symbol} className="me-3 inline-block">
                          {rule.symbol}{' '}
                          <span className="numeric text-terminal-text">
                            {rule.commissionPerLot}
                          </span>
                        </span>
                      ))}
                </td>
                <td className="numeric px-2 py-1.5 text-end text-terminal-text">{row.accounts}</td>
                <td className="numeric px-2 py-1.5 text-terminal-muted">
                  {utcTime(row.updatedAt)}
                </td>
                <td className="px-2 py-1.5 text-end">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" className="px-2 py-0.5" onClick={() => setEditing(row)}>
                      Edit
                    </Button>
                    <Button
                      variant="danger"
                      className="px-2 py-0.5"
                      gate={remove}
                      disabled={row.accounts > 0 || remove.isPending}
                      title={
                        row.accounts > 0
                          ? 'Accounts pay this schedule; move them off it first'
                          : undefined
                      }
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
      )}
    </div>
  );
}

interface DraftRule {
  symbol: string;
  commissionPerLot: string;
}

function ScheduleEditor({
  schedule,
  onDone,
}: {
  schedule: FeeScheduleRow | null;
  onDone: () => void;
}) {
  const save = useSaveFeeSchedule();
  const instruments = useAdminInstruments();
  const [name, setName] = useState(schedule?.name ?? '');
  const [note, setNote] = useState(schedule?.note ?? '');
  const [fallback, setFallback] = useState(schedule?.defaultCommissionPerLot ?? '');
  const [rules, setRules] = useState<DraftRule[]>(schedule?.rules ?? []);
  const [adding, setAdding] = useState('');

  const standard = useMemo(
    () => new Map((instruments.data ?? []).map((row) => [row.code, row])),
    [instruments.data],
  );
  const unlisted = (instruments.data ?? []).filter(
    (row) => !rules.some((rule) => rule.symbol === row.code),
  );

  const problems: string[] = [];
  if (name.trim() === '') problems.push('Give the schedule a name.');
  if (fallback.trim() !== '' && !RATE.test(fallback.trim())) {
    problems.push('The default must be a number of zero or more.');
  }
  for (const rule of rules) {
    if (!RATE.test(rule.commissionPerLot.trim())) {
      problems.push(`${rule.symbol}: enter a rate of zero or more.`);
    }
  }

  const input = (): FeeScheduleInput => ({
    name: name.trim(),
    note: note.trim() === '' ? null : note.trim(),
    defaultCommissionPerLot: fallback.trim() === '' ? null : fallback.trim(),
    rules: rules.map((rule) => ({
      symbol: rule.symbol,
      commissionPerLot: rule.commissionPerLot.trim(),
    })),
  });

  return (
    <form
      className="space-y-3 rounded-lg border border-terminal-border bg-terminal-bg/40 p-4"
      data-testid="fees-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (problems.length > 0) return;
        save.mutate(
          { ...(schedule === null ? {} : { id: schedule.id }), schedule: input() },
          { onSuccess: onDone },
        );
      }}
    >
      <h2 className="text-sm font-semibold text-terminal-text">
        {schedule === null ? 'New commission schedule' : `Edit ${schedule.name}`}
      </h2>
      {schedule !== null && schedule.accounts > 0 ? (
        <p className="text-caption text-terminal-warning">
          {schedule.accounts} account(s) pay this schedule. Saving changes what they pay from their
          next order.
        </p>
      ) : null}
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Name">
          <input
            className={wordInputClass}
            value={name}
            maxLength={60}
            placeholder="VIP, Desk A, Introducer…"
            onChange={(event) => setName(event.target.value)}
            data-testid="fees-name"
          />
        </Field>
        <Field label="Default per lot (optional)">
          <input
            className={inputClass}
            value={fallback}
            inputMode="decimal"
            placeholder="instrument’s own"
            onChange={(event) => setFallback(event.target.value)}
          />
        </Field>
        <Field label="Note (optional)">
          <input
            className={wordInputClass}
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
      </div>

      <div>
        <p className="mb-1 text-label uppercase tracking-wider text-terminal-muted">
          Instrument rates — per lot, per leg, in the instrument’s quote currency
        </p>
        {rules.length === 0 ? (
          <p className="text-caption text-terminal-muted">
            None: every instrument uses the default above, or its own rate.
          </p>
        ) : (
          <table className="w-full max-w-xl text-xs">
            <Head
              columns={['Instrument', { label: 'Standard', right: true }, 'This schedule', '']}
            />
            <tbody>
              {rules.map((rule, index) => (
                <tr key={rule.symbol} className="border-t border-terminal-border/60">
                  <td className="px-2 py-1 text-terminal-text">{rule.symbol}</td>
                  <td className="numeric px-2 py-1 text-end text-terminal-muted">
                    {standard.get(rule.symbol)?.commissionPerLot ?? '—'}
                  </td>
                  <td className="px-2 py-1">
                    <input
                      className={cn(inputClass, 'py-1')}
                      aria-label={`${rule.symbol} commission per lot`}
                      value={rule.commissionPerLot}
                      inputMode="decimal"
                      onChange={(event) =>
                        setRules(
                          rules.map((one, i) =>
                            i === index ? { ...one, commissionPerLot: event.target.value } : one,
                          ),
                        )
                      }
                      data-testid={`fees-rate-${rule.symbol}`}
                    />
                  </td>
                  <td className="px-2 py-1 text-end">
                    <Button
                      variant="ghost"
                      className="px-2 py-0.5"
                      onClick={() => setRules(rules.filter((_, i) => i !== index))}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            aria-label="Instrument to add"
            className={cn(wordInputClass, 'w-auto py-1')}
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
            data-testid="fees-add-symbol"
          >
            <option value="">Add an instrument…</option>
            {unlisted.map((row) => (
              <option key={row.code} value={row.code}>
                {row.code}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            className="px-2 py-1"
            disabled={adding === ''}
            onClick={() => {
              setRules([
                ...rules,
                { symbol: adding, commissionPerLot: standard.get(adding)?.commissionPerLot ?? '0' },
              ]);
              setAdding('');
            }}
            data-testid="fees-add"
          >
            Add
          </Button>
        </div>
      </div>

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
          data-testid="fees-save"
        >
          {save.isPending ? 'Saving…' : 'Save schedule'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const PERIODS = [
  ['Last 7 days', 7],
  ['Last 30 days', 30],
  ['Last 90 days', 90],
  ['Last 365 days', 365],
] as const;

function Report() {
  const [days, setDays] = useState<number>(30);
  // Rounded to the minute so the query key holds still between renders.
  const [anchor] = useState(() => {
    const now = new Date();
    now.setSeconds(0, 0);
    return now.getTime() + 60_000;
  });
  const to = new Date(anchor).toISOString();
  const from = new Date(anchor - days * 86_400_000).toISOString();
  const report = useFeeReport(from, to);

  return (
    <div className="space-y-4 p-3" data-testid="fees-report">
      <div className="flex flex-wrap items-center gap-1">
        {PERIODS.map(([label, value]) => (
          <button
            key={value}
            type="button"
            aria-pressed={days === value}
            onClick={() => setDays(value)}
            className={cn(
              'rounded border px-2.5 py-1 text-caption transition-colors',
              days === value
                ? 'border-terminal-accent text-terminal-text'
                : 'border-terminal-border text-terminal-muted hover:text-terminal-text',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <ErrorLine error={report.error} />
      {report.isLoading || report.data === undefined ? (
        <Loading />
      ) : (
        <>
          <p className="text-caption text-terminal-muted">
            {utcTime(report.data.from)} → {utcTime(report.data.to)} UTC. From the ledger: commission
            charged to traders, and swap settled (negative: traders paid it). Never summed across
            currencies.
          </p>
          {report.data.totals.length === 0 ? (
            <Loading>No commission or swap was charged in this period.</Loading>
          ) : (
            <div className="flex flex-wrap gap-3">
              {report.data.totals.map((line) => (
                <div
                  key={line.currency}
                  className="min-w-48 rounded-lg border border-terminal-border bg-terminal-surface p-3"
                >
                  <p className="text-label uppercase tracking-wider text-terminal-muted">
                    {line.currency}
                  </p>
                  <p className="numeric mt-1 text-lg text-terminal-text">{line.commission}</p>
                  <p className="text-label text-terminal-muted">commission</p>
                  <p className="numeric mt-1 text-sm text-terminal-text">{line.swap}</p>
                  <p className="text-label text-terminal-muted">swap</p>
                </div>
              ))}
            </div>
          )}

          {report.data.bySymbol.length === 0 ? null : (
            <div>
              <h2 className="mb-1 text-sm font-semibold text-terminal-text">By instrument</h2>
              <Table>
                <Head
                  columns={[
                    'Instrument',
                    'Currency',
                    { label: 'Commission', right: true },
                    { label: 'Swap', right: true },
                  ]}
                />
                <tbody>
                  {report.data.bySymbol.map((line) => (
                    <tr
                      key={`${line.symbol}-${line.currency}`}
                      className="border-t border-terminal-border/60"
                    >
                      <td className="px-2 py-1.5 text-terminal-text">{line.symbol}</td>
                      <td className="px-2 py-1.5 text-terminal-muted">{line.currency}</td>
                      <td className="numeric px-2 py-1.5 text-end text-terminal-text">
                        {line.commission}
                      </td>
                      <td className="numeric px-2 py-1.5 text-end text-terminal-text">
                        {line.swap}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {report.data.truncated ? (
                <p className="mt-1 text-caption text-terminal-warning">
                  More positions paid fees than this table groups; the totals above are complete.
                </p>
              ) : null}
            </div>
          )}

          {report.data.topAccounts.length === 0 ? null : (
            <div>
              <h2 className="mb-1 text-sm font-semibold text-terminal-text">
                Accounts that paid most commission
              </h2>
              <Table>
                <Head columns={['Account', 'Schedule', { label: 'Commission', right: true }]} />
                <tbody>
                  {report.data.topAccounts.map((row) => (
                    <tr
                      key={`${row.accountId}-${row.currency}`}
                      className="border-t border-terminal-border/60"
                    >
                      <td className="px-2 py-1.5">
                        <Link
                          href={`/admin/accounts/${row.accountId}`}
                          className="numeric text-terminal-accent hover:underline"
                        >
                          #{row.number}
                        </Link>
                      </td>
                      <td className="px-2 py-1.5 text-terminal-muted">
                        {row.schedule ?? 'standard'}
                      </td>
                      <td className="numeric px-2 py-1.5 text-end text-terminal-text">
                        {row.commission} {row.currency}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
