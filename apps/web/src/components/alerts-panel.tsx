'use client';

import { useMemo, useState } from 'react';
import { cn } from '@tp/ui';
import { price as formatPrice, utcTime } from '@/lib/format';
import {
  useCancelPriceAlert,
  useCreatePriceAlert,
  usePriceAlerts,
  type PriceAlertView,
  type SymbolRow,
} from '@/lib/queries';
import { useRealtime } from '@/lib/realtime-store';
import { Button, EmptyState, inputClass } from './primitives';

/**
 * Levels the trader asked to be told about.
 *
 * Deliberately not in the same list as pending orders, though they look alike
 * on screen. A pending order *does* something when the price gets there; an
 * alert only says so. Showing them together would let somebody read a line as
 * an instruction they had given, which is the single most expensive
 * misreading this screen could invite.
 */
export function AlertsPanel({
  symbols,
  activeSymbol,
}: {
  symbols: readonly SymbolRow[];
  activeSymbol: string | null;
}) {
  const alerts = usePriceAlerts();
  const create = useCreatePriceAlert();
  const cancel = useCancelPriceAlert();
  const quotes = useRealtime((state) => state.quotes);

  const [symbol, setSymbol] = useState(activeSymbol ?? '');
  const [condition, setCondition] = useState<'ABOVE' | 'BELOW'>('ABOVE');
  const [level, setLevel] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const chosen = symbol === '' ? (activeSymbol ?? '') : symbol;
  const rows = alerts.data?.alerts ?? [];

  /**
   * Active first, then whatever has happened since. A trader opening this is
   * asking "what am I still waiting on"; the history is the answer to a
   * different question and belongs under it, not mixed into it.
   */
  const ordered = useMemo(() => {
    const rank = (row: PriceAlertView) => (row.status === 'ACTIVE' ? 0 : 1);
    return [...rows].sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt));
  }, [rows]);

  const digits = (code: string) => symbols.find((row) => row.code === code)?.pricePrecision ?? 2;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (chosen === '' || level.trim() === '') return;
    try {
      await create.mutateAsync({
        symbol: chosen,
        condition,
        // A string, straight through. Turning it into a number here is how an
        // alert set at 4600 ends up watching for 4599.9999.
        price: level.trim(),
        note: note.trim() === '' ? null : note.trim(),
      });
      setLevel('');
      setNote('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not set that alert');
    }
  };

  return (
    <div className="flex h-full flex-col gap-3" data-testid="alerts-panel">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2 px-3 pt-2">
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-terminal-muted">
          Instrument
          <select
            className={inputClass}
            value={chosen}
            onChange={(event) => setSymbol(event.target.value)}
          >
            {symbols.map((row) => (
              <option key={row.code} value={row.code}>
                {row.code}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-terminal-muted">
          When
          <select
            className={inputClass}
            value={condition}
            onChange={(event) => setCondition(event.target.value === 'BELOW' ? 'BELOW' : 'ABOVE')}
          >
            <option value="ABOVE">Rises to</option>
            <option value="BELOW">Falls to</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-terminal-muted">
          Level
          <input
            className={cn(inputClass, 'w-32 text-right tabular-nums')}
            inputMode="decimal"
            value={level}
            onChange={(event) => setLevel(event.target.value)}
            placeholder={chosen === '' ? '' : (quotes[chosen]?.bid ?? '')}
          />
        </label>

        <label className="flex flex-1 flex-col gap-1 text-[10px] uppercase tracking-wider text-terminal-muted">
          Note
          <input
            className={inputClass}
            value={note}
            maxLength={280}
            onChange={(event) => setNote(event.target.value)}
            placeholder="For yourself — shown with the alert"
          />
        </label>

        <Button type="submit" disabled={create.isPending || level.trim() === ''}>
          Set alert
        </Button>
      </form>

      {error === null ? null : (
        <p className="px-3 text-xs text-terminal-loss" role="alert">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {ordered.length === 0 ? (
          <EmptyState>No alerts. Set a level above and the platform will tell you.</EmptyState>
        ) : (
          <table className="w-full min-w-[44rem] border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-terminal-surface">
              <tr className="text-left text-[10px] uppercase tracking-wider text-terminal-muted">
                <th className="px-3 py-1.5 font-medium">Symbol</th>
                <th className="px-2 py-1.5 font-medium">Condition</th>
                <th className="px-2 py-1.5 text-right font-medium">Level</th>
                <th className="px-2 py-1.5 text-right font-medium">Now</th>
                <th className="px-2 py-1.5 font-medium">Status</th>
                <th className="px-2 py-1.5 font-medium">Note</th>
                <th className="px-3 py-1.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((row) => {
                const quote = quotes[row.symbol];
                const now =
                  row.source === 'ASK' ? quote?.ask : row.source === 'BID' ? quote?.bid : undefined;
                return (
                  <tr
                    key={row.id}
                    className={cn(
                      'border-t border-terminal-border/60',
                      row.status === 'ACTIVE' ? '' : 'text-terminal-muted',
                    )}
                  >
                    <td className="px-3 py-1.5 font-medium">{row.symbol}</td>
                    <td className="px-2 py-1.5">
                      {row.condition === 'ABOVE' ? 'Rises to' : 'Falls to'}
                      <span className="ml-1 text-[10px] uppercase text-terminal-muted">
                        {row.source}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {formatPrice(row.price, digits(row.symbol))}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {/*
                        The price it fired at, once it has — not the live one.
                        A triggered alert is a record of a moment, and showing
                        it against a price that has since moved reads as though
                        the platform got it wrong.
                      */}
                      {row.triggeredPrice !== null
                        ? formatPrice(row.triggeredPrice, digits(row.symbol))
                        : now === undefined
                          ? '—'
                          : formatPrice(now, digits(row.symbol))}
                    </td>
                    <td className="px-2 py-1.5">
                      {row.status === 'TRIGGERED' && row.triggeredAt !== null
                        ? `Fired ${utcTime(row.triggeredAt)}`
                        : row.status.charAt(0) + row.status.slice(1).toLowerCase()}
                    </td>
                    <td className="max-w-[16rem] truncate px-2 py-1.5" title={row.note ?? ''}>
                      {row.note ?? ''}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {row.status === 'ACTIVE' ? (
                        <Button
                          variant="ghost"
                          disabled={cancel.isPending}
                          onClick={() => {
                            setError(null);
                            cancel.mutate(row.id, {
                              onError: (cause: unknown) => {
                                setError(
                                  cause instanceof Error ? cause.message : 'Could not cancel that',
                                );
                              },
                            });
                          }}
                        >
                          Cancel
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
