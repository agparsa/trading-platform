'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@tp/ui';
import { DomainError } from '@tp/shared-types';
import { price as formatPrice } from '@/lib/format';
import { estimateCosts, stepVolume, validateTicket } from '@/lib/ticket';
import { validateRestingPrice } from '@/lib/ticket';
import {
  useOpenPosition,
  usePlacePending,
  type AccountSummary,
  type SymbolRow,
} from '@/lib/queries';
import { useRealtime } from '@/lib/realtime-store';
import { ShortcutAction } from '@/lib/shortcuts';
import { needsConfirmation } from '@/lib/shortcuts';
import type { TradingPreferences } from '@/lib/trading-preferences';
import { Button, EmptyState, Field, inputClass } from './primitives';

/**
 * Market order entry.
 *
 * Two things about this panel are deliberate.
 *
 * First, it shows the *executable* price for the chosen side — a BUY opens at
 * the ask, a SELL at the bid — because a ticket that quotes the mid is telling
 * the trader a price they cannot get.
 *
 * Second, the costs shown are estimates and say so. They run the same
 * `@tp/financial-core` formulas the server runs, on the last quote this browser
 * received; the server prices the order against the quote current at execution.
 * Those can differ by a tick, and a ticket that implied otherwise would be
 * lying about a number the trader is about to be charged.
 */
export function OrderTicket({
  symbol,
  account,
  accountId,
  preferences,
  shortcut,
  onShortcutHandled,
}: {
  symbol: SymbolRow | undefined;
  account: AccountSummary | undefined;
  accountId: string | null;
  preferences: TradingPreferences;
  /** The last keyboard action, if any. Carries a timestamp so a repeat re-fires. */
  shortcut: { action: ShortcutAction; at: number } | null;
  onShortcutHandled: () => void;
}) {
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [orderType, setOrderType] = useState<OrderType>('MARKET');
  const [volume, setVolume] = useState('0.10');
  const [restingPrice, setRestingPrice] = useState('');
  const [timeInForce, setTimeInForce] = useState<'GTC' | 'DAY'>('GTC');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** A one-click order awaiting the confirmation the trader asked to keep. */
  const [pendingConfirm, setPendingConfirm] = useState<'BUY' | 'SELL' | null>(null);

  const quote = useRealtime((state) =>
    symbol === undefined ? undefined : state.quotes[symbol.code],
  );
  const open = useOpenPosition(accountId);
  const place = usePlacePending(accountId);

  /**
   * Adopt the trader's defaults when they change.
   *
   * Deliberately not on every render: this must not fight a trader who has
   * typed a different volume for this one order. It runs when the preference
   * itself changes — including the moment it is first read out of storage.
   */
  useEffect(() => {
    setVolume(preferences.defaultVolume);
  }, [preferences.defaultVolume]);
  useEffect(() => {
    setStopLoss(preferences.defaultStopLoss);
  }, [preferences.defaultStopLoss]);
  useEffect(() => {
    setTakeProfit(preferences.defaultTakeProfit);
  }, [preferences.defaultTakeProfit]);

  const executable = quote === undefined ? null : side === 'BUY' ? quote.ask : quote.bid;
  const resting = orderType === 'MARKET' ? null : restingPrice.trim();

  // Protective levels on a resting order are measured against the price the
  // order will open at — its own resting price — not against today's market.
  const protectiveReference = resting === null || resting === '' ? executable : resting;

  const validation = useMemo(
    () => validateTicket(symbol, side, volume, stopLoss, takeProfit, protectiveReference),
    [symbol, side, volume, stopLoss, takeProfit, protectiveReference],
  );

  const priceError = useMemo(
    () =>
      orderType === 'MARKET'
        ? null
        : validateRestingPrice(symbol, orderType, side, restingPrice, quote),
    [symbol, orderType, side, restingPrice, quote],
  );

  const estimate = useMemo(
    () => estimateCosts(symbol, account, volume, executable, validation.volumeOk),
    [symbol, account, volume, executable, validation.volumeOk],
  );

  const busy = open.isPending || place.isPending;

  /**
   * Why this ticket cannot be sent, or `null`.
   *
   * Computed here rather than inside the button's `disabled` prop because the
   * keyboard path needs the same answer. A disabled button stops a click; it
   * stops nothing at all about a keystroke, and a shortcut that skipped these
   * checks would be a second, laxer way to place an order — sending the server
   * requests the ticket already knows are wrong, and telling the trader only
   * after a round trip.
   */
  const blockedReason = useMemo(() => {
    if (accountId === null) return 'No account selected.';
    if (symbol === undefined) return 'Select an instrument.';
    if (!symbol.enabled) return `${symbol.code} is not tradeable right now.`;
    if (validation.error !== null) return validation.error;
    if (priceError !== null) return priceError;
    if (executable === null) return 'No price yet for this instrument.';
    return null;
  }, [accountId, symbol, validation.error, priceError, executable]);

  /**
   * Sends one order. The only path that does.
   *
   * Hoisted above the early return so a keyboard shortcut can reach it — and
   * kept as the single entry point for that reason. A shortcut that placed
   * orders through its own code would be a second order path with a second set
   * of rules to keep in step, which is precisely how the two drift apart.
   */
  const send = useCallback(
    async (requestedSide: 'BUY' | 'SELL') => {
      if (accountId === null || symbol === undefined) return;
      if (blockedReason !== null) {
        setSubmitError(blockedReason);
        return;
      }
      setSubmitError(null);
      const levels = {
        stopLoss: stopLoss.trim() === '' ? null : stopLoss.trim(),
        takeProfit: takeProfit.trim() === '' ? null : takeProfit.trim(),
      };
      try {
        if (orderType === 'MARKET') {
          await open.mutateAsync({
            accountId,
            symbol: symbol.code,
            side: requestedSide,
            volume,
            ...levels,
          });
        } else {
          await place.mutateAsync({
            accountId,
            symbol: symbol.code,
            side: requestedSide,
            type: orderType,
            volume,
            price: restingPrice.trim(),
            timeInForce,
            ...levels,
          });
          setRestingPrice('');
        }
        setStopLoss('');
        setTakeProfit('');
      } catch (error) {
        setSubmitError(
          error instanceof DomainError
            ? error.message
            : 'The order could not be submitted. It was not placed.',
        );
      }
    },
    [
      accountId,
      symbol,
      stopLoss,
      takeProfit,
      orderType,
      open,
      place,
      volume,
      restingPrice,
      timeInForce,
    ],
  );

  /**
   * A keyboard buy or sell.
   *
   * `handledAt` is why the effect carries a timestamp rather than the action
   * alone: pressing `b` twice is two orders, and a state that only held the
   * action would look unchanged the second time and send nothing.
   */
  const handledAt = useRef<number>(0);
  useEffect(() => {
    if (shortcut === null || shortcut.at === handledAt.current) return;
    if (shortcut.action !== ShortcutAction.BUY && shortcut.action !== ShortcutAction.SELL) return;
    handledAt.current = shortcut.at;
    onShortcutHandled();

    const requested = shortcut.action === ShortcutAction.BUY ? 'BUY' : 'SELL';
    setSide(requested);
    if (needsConfirmation(shortcut.action, preferences.confirm)) {
      setPendingConfirm(requested);
      return;
    }
    void send(requested);
  }, [shortcut, preferences.confirm, send, onShortcutHandled]);

  if (symbol === undefined) {
    return <EmptyState>Select an instrument to trade.</EmptyState>;
  }

  const canSubmit = blockedReason === null && !busy;

  const submit = () => void send(side);

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-1">
        {ORDER_TYPES.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setOrderType(value)}
            className={cn(
              'flex-1 rounded px-2 py-1 text-[11px] transition-colors',
              value === orderType
                ? 'bg-terminal-raised text-terminal-text'
                : 'text-terminal-muted hover:text-terminal-text',
            )}
          >
            {value}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <SideButton active={side === 'BUY'} side="BUY" onClick={() => setSide('BUY')}>
          <span className="numeric block text-sm">
            {quote === undefined ? '—' : formatPrice(quote.ask, symbol.pricePrecision)}
          </span>
        </SideButton>
        <SideButton active={side === 'SELL'} side="SELL" onClick={() => setSide('SELL')}>
          <span className="numeric block text-sm">
            {quote === undefined ? '—' : formatPrice(quote.bid, symbol.pricePrecision)}
          </span>
        </SideButton>
      </div>

      {/*
        The two sides again, named, with the distance between them.

        The buttons above show one price each and which one you get depends on
        which button you are looking at — fine once you know the convention, and
        opaque until then. The spread is the server's own figure from the quote
        frame, not this browser's subtraction: the number a trader uses to judge
        cost should be the number the server would quote them.
      */}
      <div className="flex items-baseline justify-between rounded border border-terminal-border/60 bg-terminal-raised/30 px-2 py-1 text-[10px] uppercase tracking-wider text-terminal-muted">
        <span>
          Bid{' '}
          <span className="numeric normal-case tracking-normal text-terminal-text">
            {quote === undefined ? '—' : formatPrice(quote.bid, symbol.pricePrecision)}
          </span>
        </span>
        <span>
          Ask{' '}
          <span className="numeric normal-case tracking-normal text-terminal-text">
            {quote === undefined ? '—' : formatPrice(quote.ask, symbol.pricePrecision)}
          </span>
        </span>
        <span title="Ask less bid, as quoted by the server">
          Spread{' '}
          <span className="numeric normal-case tracking-normal text-terminal-text">
            {quote === undefined ? '—' : formatPrice(quote.spread, symbol.pricePrecision)}
          </span>
        </span>
      </div>

      <Field
        label="Volume (lots)"
        hint={
          <span className="numeric normal-case tracking-normal">
            step {symbol.volumeStep} · min {symbol.minVolume}
          </span>
        }
      >
        <div className="flex gap-1">
          <Button
            type="button"
            variant="neutral"
            onClick={() => setVolume(stepVolume(symbol, volume, -1))}
            aria-label="Decrease volume"
          >
            −
          </Button>
          <input
            className={inputClass}
            value={volume}
            inputMode="decimal"
            onChange={(event) => setVolume(event.target.value)}
          />
          <Button
            type="button"
            variant="neutral"
            onClick={() => setVolume(stepVolume(symbol, volume, 1))}
            aria-label="Increase volume"
          >
            +
          </Button>
        </div>
      </Field>

      {orderType === 'MARKET' ? null : (
        <div className="grid grid-cols-2 gap-2">
          <Field
            label={orderType === 'LIMIT' ? 'Limit price' : 'Stop price'}
            hint={
              <span
                className="normal-case tracking-normal"
                title={
                  orderType === 'LIMIT'
                    ? 'A limit rests on the favourable side: buy below the market, sell above.'
                    : 'A stop rests on the far side: buy above the market, sell below.'
                }
              >
                {side === 'BUY'
                  ? orderType === 'LIMIT'
                    ? 'below'
                    : 'above'
                  : orderType === 'LIMIT'
                    ? 'above'
                    : 'below'}
              </span>
            }
          >
            <input
              className={inputClass}
              value={restingPrice}
              placeholder={
                executable === null ? '—' : formatPrice(executable, symbol.pricePrecision)
              }
              inputMode="decimal"
              onChange={(event) => setRestingPrice(event.target.value)}
            />
          </Field>
          <Field
            label="Valid"
            hint={
              <span
                className="normal-case tracking-normal"
                title="GTC rests until you cancel it. Day expires at the next trading-server midnight."
              >
                ?
              </span>
            }
          >
            <select
              className={inputClass}
              value={timeInForce}
              onChange={(event) => setTimeInForce(event.target.value as 'GTC' | 'DAY')}
            >
              <option value="GTC">GTC</option>
              <option value="DAY">Day</option>
            </select>
          </Field>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Stop loss">
          <input
            className={inputClass}
            value={stopLoss}
            placeholder="—"
            inputMode="decimal"
            onChange={(event) => setStopLoss(event.target.value)}
          />
        </Field>
        <Field label="Take profit">
          <input
            className={inputClass}
            value={takeProfit}
            placeholder="—"
            inputMode="decimal"
            onChange={(event) => setTakeProfit(event.target.value)}
          />
        </Field>
      </div>

      <dl className="space-y-1 rounded border border-terminal-border bg-terminal-bg px-2.5 py-2 text-[11px]">
        <EstimateRow label="Est. margin" value={estimate.margin} />
        <EstimateRow label="Est. commission" value={estimate.commission} />
        <EstimateRow
          label={orderType === 'MARKET' ? 'Executable' : 'Market now'}
          value={executable === null ? '—' : formatPrice(executable, symbol.pricePrecision)}
        />
      </dl>

      {orderType === 'MARKET' ? null : (
        <p className="text-[10px] leading-relaxed text-terminal-muted">
          No margin is held while the order rests. It is checked again when the order fires, and
          rejected if the account cannot carry it then.
        </p>
      )}

      {symbol.sessionOpen ? null : (
        <p className="text-[11px] text-terminal-warning">
          {symbol.code} is outside its trading session. The server will reject the order.
        </p>
      )}

      {priceError === null ? null : <p className="text-[11px] text-terminal-short">{priceError}</p>}
      {validation.error === null ? null : (
        <p className="text-[11px] text-terminal-short">{validation.error}</p>
      )}
      {submitError === null ? null : (
        <p className="text-[11px] text-terminal-short">{submitError}</p>
      )}

      {pendingConfirm === null ? (
        <Button
          variant={side === 'BUY' ? 'long' : 'short'}
          disabled={!canSubmit}
          onClick={() => void submit()}
          className="py-2 text-sm"
        >
          {busy
            ? 'Submitting…'
            : `${side} ${symbol.code}${orderType === 'MARKET' ? '' : ` ${orderType}`}`}
        </Button>
      ) : (
        /*
         * The confirmation a keyboard order asked for.
         *
         * It states the whole order — side, volume, instrument — rather than
         * "Are you sure?". A trader confirming a keystroke they may have half
         * pressed needs to see what they are agreeing to, not be asked whether
         * they meant something the dialog will not name.
         */
        <div className="rounded border border-terminal-warning/60 bg-terminal-warning/10 p-2">
          <p className="mb-2 text-[11px] text-terminal-text">
            Send{' '}
            <span className="numeric font-medium">
              {pendingConfirm} {volume} {symbol.code}
            </span>
            ?
          </p>
          <div className="flex gap-2">
            <Button
              variant={pendingConfirm === 'BUY' ? 'long' : 'short'}
              disabled={!canSubmit}
              onClick={() => {
                const requested = pendingConfirm;
                setPendingConfirm(null);
                void send(requested);
              }}
              className="flex-1 py-1.5 text-xs"
            >
              Send
            </Button>
            <Button
              variant="neutral"
              onClick={() => setPendingConfirm(null)}
              className="flex-1 py-1.5 text-xs"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <p className="text-[10px] leading-relaxed text-terminal-muted">
        Costs are estimates from the last quote received here. The server prices the fill against
        the quote current at execution.
        {preferences.oneClick && !preferences.confirm ? (
          <span className="mt-1 block text-terminal-warning">
            One-click is armed: keyboard orders send immediately, with no confirmation.
          </span>
        ) : null}
      </p>
    </div>
  );
}

type OrderType = 'MARKET' | 'LIMIT' | 'STOP';
const ORDER_TYPES: readonly OrderType[] = ['MARKET', 'LIMIT', 'STOP'];

function EstimateRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-terminal-muted">{label}</dt>
      <dd className="numeric text-terminal-text">{value}</dd>
    </div>
  );
}

function SideButton({
  active,
  side,
  onClick,
  children,
}: {
  active: boolean;
  side: 'BUY' | 'SELL';
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded border px-3 py-2 text-left transition-colors',
        active
          ? side === 'BUY'
            ? 'border-terminal-long bg-terminal-long/10'
            : 'border-terminal-short bg-terminal-short/10'
          : 'border-terminal-border bg-terminal-raised hover:border-terminal-muted',
      )}
    >
      <span
        className={cn(
          'block text-[10px] uppercase tracking-wider',
          side === 'BUY' ? 'text-terminal-long' : 'text-terminal-short',
        )}
      >
        {side}
      </span>
      {children}
    </button>
  );
}
