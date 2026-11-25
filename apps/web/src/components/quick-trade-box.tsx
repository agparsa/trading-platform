'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { entrySideOf } from '@tp/financial-core';
import { cn } from '@tp/ui';
import { Permission } from '@tp/shared-types';
import { price as formatPrice, signedMoney } from '@/lib/format';
import { resolveQuickOrder, type QuickOrder, type QuickOrderProblem } from '@/lib/quick-order';
import { CommandState, rejectionLines, settlementFromResponse } from '@/lib/order-commands';
import {
  useAccountState,
  useOpenPosition,
  usePermissions,
  type AccountSummary,
  type SymbolRow,
} from '@/lib/queries';
import { useRealtime } from '@/lib/realtime-store';
import {
  estimateCosts,
  inlineStartVolume,
  largeOrder,
  riskPercent as riskShareOf,
  stepVolume,
  validateTicket,
} from '@/lib/ticket';
import { playTradeSound } from '@/lib/trade-sounds';
import type { TradingPreferences } from '@/lib/trading-preferences';
import { useT } from '@/lib/use-locale';
import { useStale } from '@/lib/use-stale';
import { inputClass } from './primitives';

/**
 * The quick-trade box floating over the chart: the instrument, the bid to
 * sell at and the ask to buy at, a lots stepper and the margin the order
 * would hold.
 *
 * By default a press stages the order in the ticket, which asks before it
 * sends. Armed — the trader's own switch, which itself asks once, and only
 * where the firm allows quick trading (§95) — one press sends a market order.
 * Armed or not, it is the ticket's request through the server's checks: the
 * same validation before sending, the same idempotency key per attempt, the
 * same large-order pause (§86, which goes to the ticket instead of sending),
 * and risk, margin and session checked by the server as always. "Sent" is
 * all this box ever says by itself; a fill is reported only from the
 * server's answer, by the command log and the trade toast.
 */
export function QuickTradeBox({
  symbol,
  account,
  accountId,
  preferences,
  oneClickAllowed,
  onPreferencesChange,
  onStage,
}: {
  symbol: SymbolRow;
  account: AccountSummary | undefined;
  accountId: string | null;
  preferences: TradingPreferences;
  oneClickAllowed: boolean;
  onPreferencesChange: (patch: Partial<TradingPreferences>) => void;
  /** Hand the order to the ticket, which confirms it before sending. */
  onStage: (
    side: 'BUY' | 'SELL',
    volume: string,
    levels: { stopLoss: string | null; takeProfit: string | null },
  ) => void;
}) {
  const t = useT();
  const quote = useRealtime((state) => state.quotes[symbol.code]);
  const state = useAccountState(accountId);
  const open = useOpenPosition(accountId);
  const { data: permissions } = usePermissions();
  const [volume, setVolume] = useState(() => inlineStartVolume(symbol, preferences.defaultVolume));
  const [asking, setAsking] = useState(false);
  /** Whole points from the fill; empty for none. Reset with the instrument. */
  const [stopPoints, setStopPoints] = useState('');
  const [takePoints, setTakePoints] = useState('');
  /** Percent of equity the stop may cost; empty sizes nothing. */
  const [riskPct, setRiskPct] = useState('');
  const [note, setNote] = useState<{ tone: 'info' | 'danger' | 'warning'; lines: string[] } | null>(
    null,
  );
  const [collapsed, setCollapsed] = useStoredFlag(COLLAPSED_KEY);
  const box = useDraggable(POSITION_KEY);
  const stale = useStale(quote?.timestamp, quote !== undefined && symbol.sessionOpen);

  const armed = oneClickAllowed && preferences.oneClick && !preferences.confirm;
  const mayTrade =
    permissions === undefined || permissions.permissions.includes(Permission.ORDERS_CREATE);
  /** Set on the press itself: a double click is one order. */
  const inFlight = useRef(false);

  const words: Record<QuickOrderProblem, string> = {
    noPrice: t('wl.noPrice'),
    stopPoints: t('qt.badStop'),
    takePoints: t('qt.badTake'),
    riskNeedsStop: t('qt.riskNeedsStop'),
    riskPercent: t('qt.badRisk'),
    riskTooSmall: t('qt.riskTooSmall'),
  };
  /**
   * The order each side would send, from the price that side opens at. Both
   * are worked out so the box can show what the stop and target come to
   * before anything is pressed; a press re-resolves at that instant's price.
   */
  const resolveFor = (side: 'BUY' | 'SELL', at = quote): QuickOrder =>
    resolveQuickOrder(
      {
        spec: symbol,
        account,
        equity: state.data?.equity,
        side,
        entry: at === undefined ? null : at[entrySideOf(side)],
        volume,
        stopPoints,
        takePoints,
        riskPercent: riskPct,
      },
      words,
    );
  const preview = resolveFor('BUY');
  const sizing = riskPct.trim() !== '';
  // The lots that would go: the typed ones, or the ones the risk sizes.
  const validation = validateTicket(symbol, 'BUY', preview.volume, '', '', quote?.ask ?? null);
  const estimate = estimateCosts(
    symbol,
    account,
    'BUY',
    preview.volume,
    quote?.ask ?? null,
    validation.volumeOk,
  );

  /** Why a press cannot send, checked in the ticket's order; `null` if it can. */
  const blocked = (): string | null => {
    if (!mayTrade) {
      return t('ticket.cannotTrade', { role: permissions?.role ?? t('ticket.thisRole') });
    }
    if (accountId === null) return t('empty.noAccount');
    if (!symbol.enabled) return t('ticket.notTradeable', { code: symbol.code });
    if (!symbol.sessionOpen) return t('wl.marketClosed');
    if (validation.error !== null) return validation.error;
    if (quote === undefined) return t('wl.noPrice');
    return null;
  };

  const press = (side: 'BUY' | 'SELL') => {
    // Resolved now, at the price this press would open at.
    const order = resolveFor(side, useRealtime.getState().quotes[symbol.code]);
    if (order.error !== null) {
      setNote({ tone: 'danger', lines: [order.error] });
      return;
    }
    const lots = order.volume;
    const levels = { stopLoss: order.stopLoss, takeProfit: order.takeProfit };
    if (!armed) {
      onStage(side, lots, levels);
      return;
    }
    if (inFlight.current || open.isPending || accountId === null) return;
    const reason = blocked();
    if (reason !== null) {
      setNote({ tone: 'danger', lines: [reason] });
      return;
    }
    const executable = quote === undefined ? null : quote[entrySideOf(side)];
    const cost = estimateCosts(symbol, account, side, lots, executable, true);
    const riskShare = riskShareOf(order.ifStopped, account, state.data?.equity);
    if (largeOrder(cost.marginAmount, state.data?.freeMargin, riskShare) !== null) {
      setNote({ tone: 'warning', lines: [t('qt.large')] });
      onStage(side, lots, levels);
      return;
    }

    inFlight.current = true;
    const commandId = crypto.randomUUID();
    useRealtime.getState().startCommand({
      commandId,
      symbol: symbol.code,
      side,
      type: 'MARKET',
      volume: lots,
      at: Date.now(),
    });
    setNote({
      tone: 'info',
      lines: [t('qt.sent', { side: t(`ticket.side.${side}`), volume: lots, symbol: symbol.code })],
    });
    open
      .mutateAsync({
        commandId,
        accountId,
        symbol: symbol.code,
        side,
        volume: lots,
        ...levels,
      })
      .then((response) => {
        useRealtime
          .getState()
          .settleCommand(commandId, settlementFromResponse('MARKET', response, Date.now()));
        setNote(null);
      })
      .catch((error: unknown) => {
        const lines = rejectionLines(error);
        useRealtime.getState().settleCommand(commandId, {
          state: CommandState.REJECTED,
          reason: lines[0] ?? t('ticket.rejected'),
          at: Date.now(),
        });
        playTradeSound('order_rejected', `quick-refused:${commandId}`);
        setNote({ tone: 'danger', lines: lines.length === 0 ? [t('ticket.rejected')] : lines });
      })
      .finally(() => {
        inFlight.current = false;
      });
  };

  if (collapsed) {
    return (
      <button
        type="button"
        className="absolute left-1/2 top-2 z-20 -translate-x-1/2 rounded-full border border-terminal-border bg-terminal-surface/95 px-3 py-1 text-caption text-terminal-muted shadow-lg backdrop-blur hover:text-terminal-text"
        onClick={() => setCollapsed(false)}
        data-testid="quick-trade-show"
      >
        ⚡ {t('qt.show')}
      </button>
    );
  }

  const ready = quote !== undefined && !open.isPending;
  return (
    <div
      ref={box.ref}
      className="absolute z-20 w-[19rem] select-none rounded-lg border border-terminal-border bg-terminal-surface/95 shadow-xl backdrop-blur"
      style={box.style}
      data-testid="quick-trade-box"
    >
      <div className="flex items-center gap-2 border-b border-terminal-border px-2 py-1">
        <span
          className="cursor-grab touch-none px-1 text-terminal-muted active:cursor-grabbing"
          title={t('qt.move')}
          aria-label={t('qt.move')}
          onPointerDown={box.onPointerDown}
          data-testid="quick-trade-grip"
        >
          ⠿
        </span>
        <span className="text-caption font-medium text-terminal-text">{symbol.code}</span>
        <span className="rounded bg-terminal-raised px-1.5 text-micro uppercase tracking-wider text-terminal-muted">
          {t('qt.market')}
        </span>
        <span className="ms-auto flex items-center gap-1">
          {oneClickAllowed ? (
            <button
              type="button"
              role="switch"
              aria-checked={armed}
              aria-label={t('trade.oneClick')}
              title={armed ? t('qt.oneClickOn') : t('qt.oneClickOff')}
              className={cn(
                'rounded px-1.5 py-0.5 text-micro font-semibold uppercase tracking-wider',
                armed
                  ? 'bg-terminal-warning/20 text-terminal-warning'
                  : 'text-terminal-muted hover:text-terminal-text',
              )}
              onClick={() => {
                if (armed) onPreferencesChange({ oneClick: false, confirm: true });
                else setAsking(true);
              }}
              data-testid="quick-trade-arm"
            >
              ⚡ 1-click
            </button>
          ) : null}
          <button
            type="button"
            className="px-1 text-terminal-muted hover:text-terminal-text"
            aria-label={t('qt.hide')}
            title={t('qt.hide')}
            onClick={() => setCollapsed(true)}
          >
            –
          </button>
        </span>
      </div>

      {asking ? (
        <div className="border-b border-terminal-border bg-terminal-warning/10 p-2 text-caption">
          <p className="mb-2 text-terminal-text">{t('qt.armAsk')}</p>
          <div className="flex gap-2">
            <button
              type="button"
              className="flex-1 rounded bg-terminal-warning px-2 py-1 font-medium text-terminal-bg"
              onClick={() => {
                setAsking(false);
                onPreferencesChange({ oneClick: true, confirm: false });
              }}
              data-testid="quick-trade-arm-yes"
            >
              {t('qt.armYes')}
            </button>
            <button
              type="button"
              className="flex-1 rounded border border-terminal-border px-2 py-1 text-terminal-muted"
              onClick={() => setAsking(false)}
            >
              {t('wallet.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {/* Sell on the left at the bid, Buy on the right at the ask, in every
          language: a price ladder reads left to right like its figures. */}
      <div dir="ltr" className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-1.5 p-2">
        <SideButton
          side="SELL"
          label={t('ticket.side.SELL')}
          price={quote === undefined ? null : formatPrice(quote.bid, symbol.pricePrecision)}
          disabled={!ready}
          armed={armed}
          onClick={() => press('SELL')}
        />
        <div className="flex w-24 flex-col items-stretch justify-center rounded-md bg-terminal-raised">
          <div className="flex items-center">
            <button
              type="button"
              className="px-2 py-1 text-terminal-text"
              disabled={sizing}
              onClick={() => setVolume(stepVolume(symbol, volume, -1))}
              aria-label={t('ticket.decrease')}
            >
              −
            </button>
            <label className="min-w-0 flex-1">
              <span className="sr-only">{t('ticket.volume')}</span>
              <input
                className={cn(
                  inputClass,
                  'border-0 bg-transparent px-0 py-0 text-center text-sm focus:border-0',
                )}
                value={sizing ? preview.volume : volume}
                readOnly={sizing}
                title={sizing ? t('qt.sizedTitle') : undefined}
                inputMode="decimal"
                aria-invalid={validation.error !== null}
                onChange={(event) => setVolume(event.target.value)}
                data-testid="quick-trade-volume"
              />
            </label>
            <button
              type="button"
              className="px-2 py-1 text-terminal-text"
              disabled={sizing}
              onClick={() => setVolume(stepVolume(symbol, volume, 1))}
              aria-label={t('ticket.increase')}
            >
              +
            </button>
          </div>
          <span className="text-center text-micro uppercase tracking-wider text-terminal-muted">
            {t('pos.lots')}
          </span>
        </div>
        <SideButton
          side="BUY"
          label={t('ticket.side.BUY')}
          price={quote === undefined ? null : formatPrice(quote.ask, symbol.pricePrecision)}
          disabled={!ready}
          armed={armed}
          onClick={() => press('BUY')}
        />
      </div>

      {/* The levels, in the trader's unit for a market order: points from
          wherever it fills. Empty is "none". */}
      <div dir="ltr" className="grid grid-cols-3 gap-1.5 px-2 pb-1.5">
        <LevelField
          label={t('qt.sl')}
          tone="loss"
          value={stopPoints}
          onChange={setStopPoints}
          placeholder={t('qt.points')}
          outcome={
            preview.ifStopped === null
              ? null
              : signedMoney(preview.ifStopped, account?.currency ?? 'USD')
          }
          testId="quick-trade-sl"
        />
        <LevelField
          label={t('qt.tp')}
          tone="profit"
          value={takePoints}
          onChange={setTakePoints}
          placeholder={t('qt.points')}
          outcome={
            preview.ifTargeted === null
              ? null
              : signedMoney(preview.ifTargeted, account?.currency ?? 'USD')
          }
          testId="quick-trade-tp"
        />
        <LevelField
          label={t('qt.risk')}
          tone="warning"
          value={riskPct}
          onChange={setRiskPct}
          placeholder="%"
          outcome={sizing && preview.error === null ? `${preview.volume} ${t('pos.lots')}` : null}
          testId="quick-trade-risk"
        />
      </div>

      <div className="flex items-center justify-between gap-2 px-2.5 pb-1.5 text-micro text-terminal-muted">
        <span>
          {t('qt.spread')}{' '}
          <span className="numeric text-terminal-text">{quote?.spread ?? '—'}</span>
        </span>
        <span>
          {t('qt.margin')} <span className="numeric text-terminal-text">{estimate.margin}</span>
        </span>
      </div>

      {note !== null ? (
        <ul
          className={cn(
            'border-t border-terminal-border px-2.5 py-1 text-caption',
            note.tone === 'danger'
              ? 'text-terminal-short'
              : note.tone === 'warning'
                ? 'text-terminal-warning'
                : 'text-terminal-muted',
          )}
          role="status"
          data-testid="quick-trade-note"
        >
          {note.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (preview.error ?? validation.error) !== null && quote !== undefined ? (
        <p className="border-t border-terminal-border px-2.5 py-1 text-caption text-terminal-short">
          {preview.error ?? validation.error}
        </p>
      ) : stale ? (
        <p className="border-t border-terminal-border px-2.5 py-1 text-caption text-terminal-warning">
          {t('quote.staleTitle')}
        </p>
      ) : null}
    </div>
  );
}

function LevelField({
  label,
  tone,
  value,
  onChange,
  placeholder,
  outcome,
  testId,
}: {
  label: string;
  tone: 'loss' | 'profit' | 'warning';
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  outcome: string | null;
  testId: string;
}) {
  const on = value.trim() !== '';
  return (
    <label
      className={cn(
        'flex min-w-0 flex-col rounded-md border px-1.5 py-1 transition-colors',
        !on
          ? 'border-terminal-border'
          : tone === 'loss'
            ? 'border-terminal-short/70 bg-terminal-short/10'
            : tone === 'profit'
              ? 'border-terminal-profit/70 bg-terminal-profit/10'
              : 'border-terminal-warning/70 bg-terminal-warning/10',
      )}
    >
      <span
        className={cn(
          'text-micro font-semibold uppercase tracking-wider',
          !on
            ? 'text-terminal-muted'
            : tone === 'loss'
              ? 'text-terminal-short'
              : tone === 'profit'
                ? 'text-terminal-profit'
                : 'text-terminal-warning',
        )}
      >
        {label}
      </span>
      <input
        className={cn(inputClass, 'border-0 bg-transparent px-0 py-0 text-sm focus:border-0')}
        value={value}
        placeholder={placeholder}
        inputMode="decimal"
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
      />
      <span className="numeric min-h-[1em] truncate text-micro text-terminal-muted">
        {outcome ?? ''}
      </span>
    </label>
  );
}

function SideButton({
  side,
  label,
  price,
  disabled,
  armed,
  onClick,
}: {
  side: 'BUY' | 'SELL';
  label: string;
  price: string | null;
  disabled: boolean;
  armed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-md px-2 py-1.5 text-center font-medium text-terminal-bg shadow-sm transition-[filter,opacity] hover:brightness-110 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-50',
        side === 'BUY' ? 'bg-terminal-long' : 'bg-terminal-short',
        armed && 'ring-1 ring-terminal-warning/70',
      )}
      data-testid={`quick-trade-${side.toLowerCase()}`}
    >
      <span className="block text-label uppercase tracking-wider">{label}</span>
      <span className="numeric block text-sm">{price ?? '—'}</span>
    </button>
  );
}

const POSITION_KEY = 'tp.quickTrade.position';
const COLLAPSED_KEY = 'tp.quickTrade.collapsed';

/** A remembered on/off, per browser. Storage that throws or is empty means "off". */
function useStoredFlag(key: string): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    try {
      setOn(window.localStorage.getItem(key) === '1');
    } catch {
      // Private window or blocked storage: the default stands.
    }
  }, [key]);
  const set = useCallback(
    (next: boolean) => {
      setOn(next);
      try {
        window.localStorage.setItem(key, next ? '1' : '0');
      } catch {
        // Not remembered; it still works for this visit.
      }
    },
    [key],
  );
  return [on, set];
}

/**
 * Where the box sits: top centre until the trader drags it, then where they
 * left it — kept inside the chart and remembered for their next visit.
 */
function useDraggable(key: string) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return;
      const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        setPlace({ x: parsed.x, y: parsed.y });
      }
    } catch {
      // Nothing remembered: top centre.
    }
  }, [key]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const node = ref.current;
      const parent = node?.offsetParent as HTMLElement | null | undefined;
      if (node === null || parent === null || parent === undefined) return;
      event.preventDefault();
      const startX = event.clientX - node.offsetLeft;
      const startY = event.clientY - node.offsetTop;
      let last = { x: node.offsetLeft, y: node.offsetTop };
      const move = (e: PointerEvent) => {
        const maxX = Math.max(0, parent.clientWidth - node.offsetWidth);
        const maxY = Math.max(0, parent.clientHeight - node.offsetHeight);
        last = {
          x: Math.min(maxX, Math.max(0, e.clientX - startX)),
          y: Math.min(maxY, Math.max(0, e.clientY - startY)),
        };
        setPlace(last);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        try {
          window.localStorage.setItem(key, JSON.stringify(last));
        } catch {
          // Not remembered; it stays put for this visit.
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [key],
  );

  const style: React.CSSProperties =
    place === null
      ? { left: '50%', top: 8, transform: 'translateX(-50%)' }
      : // Kept on the chart even when it is smaller than when the box was left.
        {
          left: `min(${place.x}px, calc(100% - 19rem))`,
          top: `min(${place.y}px, calc(100% - 7rem))`,
        };
  return { ref, style, onPointerDown };
}
