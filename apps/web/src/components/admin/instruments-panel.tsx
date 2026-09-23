'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import {
  useAdminInstruments,
  useInstrumentSessions,
  useSetInstrumentEnabled,
  useSetInstrumentSessions,
  useSetInstrumentTerms,
  type AdminInstrumentRow,
} from '@/lib/admin-queries';
import { Button, inputClass } from '@/components/primitives';
import { markClasses, markFor } from '@/lib/instrument-marks';
import { ErrorLine, Head, Loading, Table } from './shared';

/**
 * What the platform trades, and on what terms.
 *
 * The contract specification — tick size, contract size, precision — is shown
 * and not editable. Those describe the instrument itself, and changing one under
 * open positions re-values every trade ever made in it: a position opened at a
 * tick size of 0.01 and closed at 0.001 reconciles against nothing. That is a
 * migration with trading halted, not a form field.
 *
 * What is editable is what the firm charges and requires. Each change asks for a
 * reason and says how many positions it just affected.
 */
export function InstrumentsPanel() {
  const instruments = useAdminInstruments();
  const [editing, setEditing] = useState<string | null>(null);

  if (instruments.isPending) return <Loading>Loading instruments…</Loading>;
  if (instruments.isError) return <ErrorLine error={instruments.error} />;

  const rows = instruments.data ?? [];
  if (rows.length === 0) {
    return <p className="p-6 text-xs text-terminal-muted">No instruments are configured.</p>;
  }

  return (
    <div className="p-3">
      <Table>
        <Head
          columns={[
            'Instrument',
            'Class',
            { label: 'Margin', right: true },
            { label: 'Commission', right: true },
            { label: 'Swap long', right: true },
            { label: 'Swap short', right: true },
            { label: 'Max lots', right: true },
            { label: 'Tick', right: true },
            { label: 'Open', right: true },
            { label: 'Resting', right: true },
            'Status',
            '',
          ]}
        />
        <tbody>
          {rows.map((row) => (
            <InstrumentRow
              key={row.code}
              row={row}
              editing={editing === row.code}
              onEdit={() => setEditing(editing === row.code ? null : row.code)}
            />
          ))}
        </tbody>
      </Table>
      <p className="mt-3 text-[11px] leading-relaxed text-terminal-muted">
        Tick size, contract size and precision describe the instrument rather than the firm&apos;s
        terms, so they are shown here and changed by migration. Suspending an instrument stops new
        orders and closes nothing — the positions already open stay open, and stay the
        trader&apos;s.
      </p>
    </div>
  );
}

function InstrumentRow({
  row,
  editing,
  onEdit,
}: {
  row: AdminInstrumentRow;
  editing: boolean;
  onEdit: () => void;
}) {
  const mark = markFor(row.code);
  return (
    <>
      <tr className="border-t border-terminal-border/60">
        <td className="px-2 py-1.5">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                'inline-flex h-4 w-6 shrink-0 items-center justify-center rounded-sm text-[10px] font-semibold leading-none ring-1 ring-inset',
                markClasses(mark.kind),
              )}
            >
              {mark.glyph}
            </span>
            <span className="font-medium text-terminal-text">{row.code}</span>
            <span className="text-terminal-muted">{row.description}</span>
          </div>
        </td>
        <td className="px-2 py-1.5 text-terminal-muted">{row.category}</td>
        <td className="numeric px-2 py-1.5 text-right">{row.marginRate}</td>
        <td className="numeric px-2 py-1.5 text-right">{row.commissionPerLot}</td>
        <td className="numeric px-2 py-1.5 text-right">{row.swapLongPerLot}</td>
        <td className="numeric px-2 py-1.5 text-right">{row.swapShortPerLot}</td>
        <td className="numeric px-2 py-1.5 text-right">{row.maxVolume}</td>
        <td className="numeric px-2 py-1.5 text-right text-terminal-muted">{row.tickSize}</td>
        <td className="numeric px-2 py-1.5 text-right">{row.openPositions}</td>
        <td className="numeric px-2 py-1.5 text-right">{row.restingOrders}</td>
        <td className="px-2 py-1.5">
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider',
              row.enabled
                ? 'bg-terminal-long/15 text-terminal-long'
                : 'bg-terminal-short/15 text-terminal-short',
            )}
          >
            {row.enabled ? 'Trading' : 'Suspended'}
          </span>
        </td>
        <td className="px-2 py-1.5 text-right">
          <button
            type="button"
            onClick={onEdit}
            className="rounded border border-terminal-border px-2 py-0.5 text-[11px] text-terminal-muted transition-colors hover:text-terminal-text"
          >
            {editing ? 'Close' : 'Edit'}
          </button>
        </td>
      </tr>
      {editing ? (
        <tr className="border-t border-terminal-border/60 bg-terminal-raised/40">
          <td colSpan={12} className="space-y-4 px-3 py-3">
            <InstrumentEditor row={row} />
            <SessionEditor code={row.code} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function InstrumentEditor({ row }: { row: AdminInstrumentRow }) {
  const setEnabled = useSetInstrumentEnabled();
  const setTerms = useSetInstrumentTerms();

  const [reason, setReason] = useState('');
  const [terms, setTermsState] = useState({
    marginRate: row.marginRate,
    commissionPerLot: row.commissionPerLot,
    swapLongPerLot: row.swapLongPerLot,
    swapShortPerLot: row.swapShortPerLot,
    maxVolume: row.maxVolume,
  });

  const changed = (Object.keys(terms) as Array<keyof typeof terms>).filter(
    (field) => terms[field] !== row[field],
  );
  const reasonOk = reason.trim().length >= 8;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Field
          label="Margin rate"
          value={terms.marginRate}
          onChange={(v) => setTermsState({ ...terms, marginRate: v })}
        />
        <Field
          label="Commission / lot"
          value={terms.commissionPerLot}
          onChange={(v) => setTermsState({ ...terms, commissionPerLot: v })}
        />
        <Field
          label="Swap long / lot"
          value={terms.swapLongPerLot}
          onChange={(v) => setTermsState({ ...terms, swapLongPerLot: v })}
        />
        <Field
          label="Swap short / lot"
          value={terms.swapShortPerLot}
          onChange={(v) => setTermsState({ ...terms, swapShortPerLot: v })}
        />
        <Field
          label="Max lots"
          value={terms.maxVolume}
          onChange={(v) => setTermsState({ ...terms, maxVolume: v })}
        />
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-terminal-muted">
          Reason — goes in the audit trail
        </span>
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why this is changing"
          className="rounded border border-terminal-border bg-terminal-panel px-2 py-1 text-xs text-terminal-text"
        />
      </label>

      {/*
        Raising the margin rate changes the margin required by every position
        already open in this instrument, and can put an account into margin call
        without anyone touching that account. Saying so beside the button is
        cheaper than finding out afterwards.
      */}
      {changed.includes('marginRate') && row.openPositions > 0 ? (
        <p className="text-[11px] text-terminal-warning">
          {row.openPositions} position{row.openPositions === 1 ? '' : 's'} open in {row.code}. A
          higher margin rate applies to {row.openPositions === 1 ? 'it' : 'them'} immediately and
          can put an account into margin call.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={changed.length === 0 || !reasonOk || setTerms.isPending}
          onClick={() =>
            setTerms.mutate(
              Object.fromEntries([
                ['code', row.code],
                ['reason', reason.trim()],
                ...changed.map((field) => [field, terms[field]]),
              ]) as never,
              { onSuccess: () => setReason('') },
            )
          }
          className="rounded bg-terminal-accent px-3 py-1 text-xs font-medium text-terminal-bg disabled:opacity-40"
        >
          {changed.length === 0 ? 'No changes' : `Save ${changed.length} change(s)`}
        </button>

        <button
          type="button"
          disabled={!reasonOk || setEnabled.isPending}
          onClick={() =>
            setEnabled.mutate(
              { code: row.code, enabled: !row.enabled, reason: reason.trim() },
              { onSuccess: () => setReason('') },
            )
          }
          className={cn(
            'rounded border px-3 py-1 text-xs transition-colors disabled:opacity-40',
            row.enabled
              ? 'border-terminal-short/50 text-terminal-short hover:bg-terminal-short/10'
              : 'border-terminal-long/50 text-terminal-long hover:bg-terminal-long/10',
          )}
        >
          {row.enabled ? 'Suspend trading' : 'Resume trading'}
        </button>

        {reasonOk ? null : (
          <span className="text-[11px] text-terminal-muted">
            A reason of at least 8 characters is required.
          </span>
        )}
      </div>

      {setTerms.isError ? <ErrorLine error={setTerms.error} /> : null}
      {setEnabled.isError ? <ErrorLine error={setEnabled.error} /> : null}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-terminal-muted">{label}</span>
      <input
        value={value}
        inputMode="decimal"
        onChange={(event) => onChange(event.target.value)}
        className="numeric rounded border border-terminal-border bg-terminal-panel px-2 py-1 text-xs text-terminal-text"
      />
    </label>
  );
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** `540` → `09:00`. Minutes are what is stored; a clock is what a person reads. */
function clock(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** `09:00` → `540`, or null when it is not a time. */
function minutesOf(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  return total > 1440 ? null : total;
}

/**
 * When this instrument trades.
 *
 * The week is edited and saved **whole**. Saving day by day would mean a
 * moment where Monday has been written and Tuesday has not, and that moment is
 * a market that is open when it should be shut. It also makes "close Friday an
 * hour earlier" one audited change rather than a sequence somebody could stop
 * halfway.
 *
 * A day left blank is a day the market does not open. Sessions are when the
 * *venue* trades, so the server refuses this from a broker — a firm that wants
 * an instrument shut suspends it above.
 */
function SessionEditor({ code }: { code: string }) {
  const sessions = useInstrumentSessions(code);
  const save = useSetInstrumentSessions();
  const [draft, setDraft] = useState<Record<number, { open: string; close: string }> | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const stored = sessions.data;
  const current =
    draft ??
    Object.fromEntries(
      DAYS.map((_, day) => {
        const window = stored?.windows.find((one) => one.dayOfWeek === day);
        return [
          day,
          window === undefined
            ? { open: '', close: '' }
            : { open: clock(window.openMinute), close: clock(window.closeMinute) },
        ];
      }),
    );
  const zone = timezone ?? stored?.timezone ?? 'UTC';

  const set = (day: number, part: 'open' | 'close', value: string) => {
    setDraft({ ...current, [day]: { ...current[day], [part]: value } as never });
  };

  const windows = Object.entries(current)
    .map(([day, value]) => {
      const open = minutesOf(value.open);
      const close = minutesOf(value.close);
      if (open === null || close === null) return null;
      return { dayOfWeek: Number(day), openMinute: open, closeMinute: close };
    })
    .filter((window): window is NonNullable<typeof window> => window !== null);

  const malformed = Object.values(current).some(
    (value) =>
      (value.open.trim() !== '' && minutesOf(value.open) === null) ||
      (value.close.trim() !== '' && minutesOf(value.close) === null) ||
      (value.open.trim() === '') !== (value.close.trim() === ''),
  );

  return (
    <div className="space-y-3 border-t border-terminal-border/60 pt-3" data-testid="session-editor">
      <p className="text-[10px] uppercase tracking-wider text-terminal-muted">Trading week</p>
      <p className="text-[11px] text-terminal-muted">
        A day left blank is a day this instrument does not open. Times are in the session&apos;s own
        timezone. Saved whole: a half-saved week is a market that is open when it should be shut.
      </p>
      <ErrorLine error={sessions.error ?? save.error} />
      {sessions.isPending ? (
        <Loading>Loading the week…</Loading>
      ) : (
        <>
          <div className="grid gap-2 md:grid-cols-4 lg:grid-cols-7">
            {DAYS.map((name, day) => (
              <label key={name} className="space-y-1">
                <span className="block text-[10px] uppercase tracking-wider text-terminal-muted">
                  {name.slice(0, 3)}
                </span>
                <input
                  className={cn(inputClass, 'py-1 text-center text-xs')}
                  value={current[day]?.open ?? ''}
                  onChange={(event) => set(day, 'open', event.target.value)}
                  placeholder="closed"
                  aria-label={`${name} opens`}
                />
                <input
                  className={cn(inputClass, 'py-1 text-center text-xs')}
                  value={current[day]?.close ?? ''}
                  onChange={(event) => set(day, 'close', event.target.value)}
                  placeholder="closed"
                  aria-label={`${name} closes`}
                />
              </label>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="space-y-1">
              <span className="block text-[10px] uppercase tracking-wider text-terminal-muted">
                Timezone
              </span>
              <input
                className={cn(inputClass, 'py-1 text-xs')}
                value={zone}
                onChange={(event) => setTimezone(event.target.value)}
                placeholder="Europe/London"
              />
            </label>
            <label className="space-y-1 md:col-span-2">
              <span className="block text-[10px] uppercase tracking-wider text-terminal-muted">
                Why
              </span>
              <input
                className={cn(inputClass, 'py-1 text-xs')}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="the venue moved its Friday close"
              />
            </label>
          </div>
          {malformed ? (
            <p className="text-[11px] text-terminal-warning">
              Give each open day both an opening and a closing time, as HH:MM. A window that crosses
              midnight is two days: one ending 24:00, one starting 00:00.
            </p>
          ) : null}
          <Button
            onClick={() =>
              save.mutate(
                { code, timezone: zone.trim(), windows, reason: reason.trim() },
                {
                  onSuccess: () => {
                    setDraft(null);
                    setTimezone(null);
                    setReason('');
                  },
                },
              )
            }
            disabled={malformed || reason.trim().length < 8 || save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Save the week'}
          </Button>
        </>
      )}
    </div>
  );
}
