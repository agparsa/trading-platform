'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { DomainError } from '@tp/shared-types';
import {
  money,
  price as formatPrice,
  signedMoney,
  toneClass,
  toneOf,
  utcTime,
  volume as formatVolume,
} from '@/lib/format';
import {
  useCloseAllPositions,
  useClosePosition,
  useModifyPosition,
  type AccountStateResponse,
  type PendingOrderRow,
  type PositionRow,
  type SymbolRow,
} from '@/lib/queries';
import { useRealtime } from '@/lib/realtime-store';
import type { TradingPreferences } from '@/lib/trading-preferences';
import { useT } from '@/lib/use-locale';
import { HistoryPanel } from './history-panel';
import { PendingPanel } from './pending-panel';
import { PositionEditor } from './positions-panel';
import { Button, EmptyState, SideBadge } from './primitives';

type Section = 'open' | 'pending' | 'closed';

/**
 * The phone's Trades tab: what the account holds, as cards.
 *
 * A table of sixteen columns does not fit 390 pixels, and a sideways scroll
 * is where a stop-loss column goes to be missed. Each position is a card that
 * says the four things a trader checks — side and size, entry to now, the
 * result, the levels — and opens to the rest and to its actions. The figures
 * are the server's, from the same queries and the same socket as the desktop
 * table: this is a second layout, not a second calculation.
 */
export function PhonePositions({
  positions,
  pending,
  symbols,
  accountId,
  currency,
  state,
  preferences,
}: {
  positions: readonly PositionRow[];
  pending: readonly PendingOrderRow[];
  symbols: readonly SymbolRow[];
  accountId: string | null;
  currency: string;
  state: Partial<AccountStateResponse> | null;
  preferences: TradingPreferences;
}) {
  const t = useT();
  const [section, setSection] = useState<Section>('open');
  const [askAll, setAskAll] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const closeAll = useCloseAllPositions(accountId);

  const sections: ReadonlyArray<{ id: Section; label: string; count?: number }> = [
    { id: 'open', label: t('tab.positions'), count: positions.length },
    { id: 'pending', label: t('tab.pending'), count: pending.length },
    { id: 'closed', label: t('tab.closed') },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-3 gap-2 px-3 pt-3">
        <SummaryCard label={t('account.equity')} value={money(state?.equity, currency)} />
        <SummaryCard label={t('account.usedMargin')} value={money(state?.usedMargin, currency)} />
        <SummaryCard label={t('account.freeMargin')} value={money(state?.freeMargin, currency)} />
      </div>

      <div
        role="tablist"
        aria-label={t('terminal.activity')}
        className="mt-3 flex shrink-0 gap-1 border-b border-terminal-border px-3"
      >
        {sections.map((one) => (
          <button
            key={one.id}
            type="button"
            role="tab"
            aria-selected={section === one.id}
            onClick={() => setSection(one.id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-xs transition-colors',
              section === one.id
                ? 'border-terminal-accent text-terminal-text'
                : 'border-transparent text-terminal-muted',
            )}
          >
            {one.label}
            {one.count === undefined ? null : (
              <span className="ms-1.5 rounded bg-terminal-raised px-1.5 text-label">
                <span className="numeric">{one.count}</span>
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="phone-positions">
        {section === 'pending' ? (
          <PendingPanel orders={pending} symbols={symbols} accountId={accountId} />
        ) : section === 'closed' ? (
          <HistoryPanel tab="closed" accountId={accountId} symbols={symbols} currency={currency} />
        ) : positions.length === 0 ? (
          <EmptyState>{t('empty.positions')}</EmptyState>
        ) : (
          <div className="space-y-2 p-3">
            {notice === null ? null : (
              <p className="text-caption text-terminal-warning" role="status">
                {notice}
              </p>
            )}
            {positions.map((position) => (
              <PositionCard
                key={position.id}
                position={position}
                spec={symbols.find((symbol) => symbol.code === position.symbol)}
                accountId={accountId}
                currency={currency}
                equity={state?.equity ?? null}
                confirm={preferences.confirm}
                fallback={state?.positions?.find((one) => one.positionId === position.id)}
              />
            ))}
            <div className="flex justify-center pt-2">
              {askAll ? (
                <div className="flex w-full items-center gap-2 rounded border border-terminal-warning/50 bg-terminal-warning/10 p-2">
                  <span className="flex-1 text-caption text-terminal-text">
                    {t(positions.length === 1 ? 'pos.confirm.allOne' : 'pos.confirm.allMany', {
                      count: positions.length,
                    })}
                  </span>
                  <Button
                    variant="danger"
                    className="px-2 py-1"
                    disabled={closeAll.isPending || accountId === null}
                    onClick={() => {
                      setAskAll(false);
                      setNotice(null);
                      if (accountId === null) return;
                      void closeAll
                        .mutateAsync({ accountId })
                        .then((result) => {
                          if (result.refused.length > 0) {
                            setNotice(
                              t('pos.closedSomeLeft', {
                                closed: result.closed.length,
                                left: result.refused.length,
                              }),
                            );
                          }
                        })
                        .catch(() => setNotice(t('pos.closeAllFailed')));
                    }}
                  >
                    {t('pos.close')}
                  </Button>
                  <Button variant="ghost" className="px-2 py-1" onClick={() => setAskAll(false)}>
                    {t('wallet.cancel')}
                  </Button>
                </div>
              ) : (
                <Button variant="neutral" className="px-4 py-2" onClick={() => setAskAll(true)}>
                  {t('trade.closeAll')}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-terminal-surface px-2.5 py-2">
      <p className="truncate text-label text-terminal-muted">{label}</p>
      <p className="numeric truncate text-xs text-terminal-text">{value}</p>
    </div>
  );
}

/**
 * One position. Closed, it is a summary; opened, it shows the rest and the
 * actions. "Break even" moves the stop to the entry price and keeps the
 * target and the trail as they are — one modify, which the server refuses
 * when the market is on the wrong side of the entry for a stop to sit there,
 * and the card says so in the server's words.
 */
function PositionCard({
  position,
  spec,
  accountId,
  currency,
  equity,
  confirm,
  fallback,
}: {
  fallback: { floatingPnl: string | null; currentPrice: string | null } | undefined;
  position: PositionRow;
  spec: SymbolRow | undefined;
  accountId: string | null;
  currency: string;
  equity: string | null;
  confirm: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useClosePosition(accountId);
  const modify = useModifyPosition(accountId);
  const live = useRealtime((state) => state.pnl[position.id]);
  const precision = spec?.pricePrecision ?? 2;
  // The socket's figure, else the snapshot's — as the desktop table does.
  const pnl = live?.floatingPnl ?? fallback?.floatingPnl ?? null;
  const current = live?.currentPrice ?? fallback?.currentPrice ?? position.currentPrice;
  const busy = close.isPending || modify.isPending;

  const failed = (caught: unknown) =>
    setError(caught instanceof DomainError ? caught.message : t('pos.requestFailed'));

  const closeNow = () => {
    setAsking(false);
    setError(null);
    void close.mutateAsync({ positionId: position.id, volume: null }).catch(failed);
  };

  return (
    <article
      className="rounded-lg border border-terminal-border bg-terminal-surface"
      data-testid="position-card"
    >
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-start"
        aria-expanded={open}
        onClick={() => setOpen((now) => !now)}
      >
        <span className="min-w-0 space-y-1">
          <span className="block text-sm font-medium text-terminal-text">{position.symbol}</span>
          <span className="flex items-center gap-1.5 text-caption text-terminal-muted">
            <SideBadge side={position.side} />
            <span className="numeric text-terminal-text">{formatVolume(position.volume)}</span>
            {t('pos.lots')}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span
            className={cn(
              'numeric inline-block rounded px-1.5 py-0.5 text-xs',
              toneClass[toneOf(pnl)],
              toneOf(pnl) === 'profit'
                ? 'bg-terminal-long/10'
                : toneOf(pnl) === 'loss'
                  ? 'bg-terminal-short/10'
                  : '',
            )}
          >
            {signedMoney(pnl, currency)}
          </span>
          <span className="numeric block text-caption text-terminal-muted">
            {formatPrice(position.entryPrice, precision)} → {formatPrice(current, precision)}
          </span>
        </span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-terminal-border/60 px-3 py-2.5">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
            <Fact
              label={t('ticket.stopLoss')}
              value={position.stopLoss === null ? '—' : formatPrice(position.stopLoss, precision)}
            />
            <Fact
              label={t('ticket.takeProfit')}
              value={
                position.takeProfit === null ? '—' : formatPrice(position.takeProfit, precision)
              }
            />
            <Fact
              label={`${t('col.swap')} / ${t('col.commission')}`}
              value={`${money(position.swap, currency)} / ${money(position.commission, currency)}`}
            />
            <Fact label={t('pos.margin')} value={money(position.margin, currency)} />
            <Fact label={t('col.openedUtc')} value={utcTime(position.openedAt)} />
            <Fact label={t('pos.ref')} value={position.id.slice(0, 8)} />
          </dl>

          {asking ? (
            <div className="flex items-center gap-2 rounded border border-terminal-warning/50 bg-terminal-warning/10 p-2">
              <span className="flex-1 text-caption text-terminal-text">
                {t('pos.confirm.one', {
                  volume: formatVolume(position.volume),
                  symbol: position.symbol,
                })}
              </span>
              <Button variant="danger" className="px-2 py-1" disabled={busy} onClick={closeNow}>
                {t('pos.close')}
              </Button>
              <Button variant="ghost" className="px-2 py-1" onClick={() => setAsking(false)}>
                {t('wallet.cancel')}
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              <Button
                variant="neutral"
                className="py-2 text-caption"
                aria-expanded={editing}
                onClick={() => setEditing((now) => !now)}
              >
                {editing ? t('pos.closePanel') : t('pos.edit')}
              </Button>
              <Button
                variant="neutral"
                className="py-2 text-caption"
                disabled={busy}
                title={t('pos.breakEvenTitle')}
                onClick={() => {
                  setError(null);
                  void modify
                    .mutateAsync({
                      positionId: position.id,
                      stopLoss: position.entryPrice,
                      takeProfit: position.takeProfit,
                      trailingStopDistance: position.trailingStopDistance,
                    })
                    .catch(failed);
                }}
              >
                {t('pos.breakEven')}
              </Button>
              <Button
                variant="danger"
                className="py-2 text-caption"
                disabled={busy}
                onClick={() => (confirm ? setAsking(true) : closeNow())}
              >
                {t('pos.close')}
              </Button>
            </div>
          )}

          {editing ? (
            <PositionEditor
              position={position}
              spec={spec}
              accountId={accountId}
              currency={currency}
              equity={equity}
              onDone={() => setEditing(false)}
            />
          ) : null}

          {error === null ? null : (
            <p className="text-caption text-terminal-short" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : null}
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-label uppercase tracking-wider text-terminal-muted">{label}</dt>
      <dd className="numeric truncate text-caption text-terminal-text">{value}</dd>
    </div>
  );
}
