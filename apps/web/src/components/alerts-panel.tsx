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
import { Button, EmptyState, inputClass, wordInputClass } from './primitives';
import type { MessageKey } from '@/lib/messages';
import { useT } from '@/lib/use-locale';

/** An alert's status in words. */
const STATUS_WORDS: Record<string, MessageKey> = {
  ACTIVE: 'alerts.status.ACTIVE',
  TRIGGERED: 'alerts.status.TRIGGERED',
  CANCELLED: 'alerts.status.CANCELLED',
  EXPIRED: 'alerts.status.EXPIRED',
};

function statusInWords(status: string, t: (key: MessageKey) => string): string {
  const key = STATUS_WORDS[status];
  return key === undefined ? status : t(key);
}

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
  const t = useT();
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
      setError(cause instanceof Error ? cause.message : t('alerts.setFailed'));
    }
  };

  return (
    <div className="flex h-full flex-col gap-3" data-testid="alerts-panel">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2 px-3 pt-2">
        <label className="flex flex-col gap-1 text-label uppercase tracking-wider text-terminal-muted">
          {t('alerts.instrument')}
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

        <label className="flex flex-col gap-1 text-label uppercase tracking-wider text-terminal-muted">
          {t('alerts.when')}
          <select
            className={wordInputClass}
            value={condition}
            onChange={(event) => setCondition(event.target.value === 'BELOW' ? 'BELOW' : 'ABOVE')}
          >
            <option value="ABOVE">{t('alerts.risesTo')}</option>
            <option value="BELOW">{t('alerts.fallsTo')}</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-label uppercase tracking-wider text-terminal-muted">
          {t('col.level')}
          <input
            className={cn(inputClass, 'w-32 text-end tabular-nums')}
            inputMode="decimal"
            value={level}
            onChange={(event) => setLevel(event.target.value)}
            placeholder={chosen === '' ? '' : (quotes[chosen]?.bid ?? '')}
          />
        </label>

        <label className="flex flex-1 flex-col gap-1 text-label uppercase tracking-wider text-terminal-muted">
          {t('col.note')}
          <input
            className={wordInputClass}
            value={note}
            maxLength={280}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t('alerts.notePlaceholder')}
          />
        </label>

        <Button type="submit" disabled={create.isPending || level.trim() === ''}>
          {t('alerts.set')}
        </Button>
      </form>

      {error === null ? null : (
        <p className="px-3 text-xs text-terminal-short" role="alert">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {ordered.length === 0 ? (
          <EmptyState>{t('alerts.empty')}</EmptyState>
        ) : (
          <table className="w-full min-w-[44rem] border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-terminal-surface">
              <tr className="text-start text-label uppercase tracking-wider text-terminal-muted">
                <th className="px-3 py-1.5 font-medium">{t('col.symbol')}</th>
                <th className="px-2 py-1.5 font-medium">{t('col.condition')}</th>
                <th className="px-2 py-1.5 text-end font-medium">{t('col.level')}</th>
                <th className="px-2 py-1.5 text-end font-medium">{t('col.now')}</th>
                <th className="px-2 py-1.5 font-medium">{t('col.status')}</th>
                <th className="px-2 py-1.5 font-medium">{t('col.note')}</th>
                <th className="px-3 py-1.5 text-end font-medium">{t('col.actions')}</th>
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
                      {row.condition === 'ABOVE' ? t('alerts.risesTo') : t('alerts.fallsTo')}
                      <span className="ms-1 text-label uppercase text-terminal-muted">
                        {row.source}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-end tabular-nums">
                      {formatPrice(row.price, digits(row.symbol))}
                    </td>
                    <td className="px-2 py-1.5 text-end tabular-nums">
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
                        ? t('alerts.fired', { time: utcTime(row.triggeredAt) })
                        : statusInWords(row.status, t)}
                    </td>
                    <td className="max-w-[16rem] truncate px-2 py-1.5" title={row.note ?? ''}>
                      {row.note ?? ''}
                    </td>
                    <td className="px-3 py-1.5 text-end">
                      {row.status === 'ACTIVE' ? (
                        <Button
                          variant="ghost"
                          disabled={cancel.isPending}
                          onClick={() => {
                            setError(null);
                            cancel.mutate(row.id, {
                              onError: (cause: unknown) => {
                                setError(
                                  cause instanceof Error ? cause.message : t('alerts.cancelFailed'),
                                );
                              },
                            });
                          }}
                        >
                          {t('wallet.cancel')}
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
