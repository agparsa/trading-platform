'use client';

import { useMemo, useState } from 'react';
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
}: {
  symbol: SymbolRow | undefined;
  account: AccountSummary | undefined;
  accountId: string | null;
}) {
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [orderType, setOrderType] = useState<OrderType>('MARKET');
  const [volume, setVolume] = useState('0.10');
  const [restingPrice, setRestingPrice] = useState('');
  const [timeInForce, setTimeInForce] = useState<'GTC' | 'DAY'>('GTC');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const quote = useRealtime((state) =>
    symbol === undefined ? undefined : state.quotes[symbol.code],
  );
  const open = useOpenPosition(accountId);
  const place = usePlacePending(accountId);

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

  if (symbol === undefined) {
    return <EmptyState>Select an instrument to trade.</EmptyState>;
  }

  const busy = open.isPending || place.isPending;
  const canSubmit =
    accountId !== null &&
    validation.error === null &&
    priceError === null &&
    executable !== null &&
    symbol.enabled &&
    !busy;

  const submit = async () => {
    if (accountId === null) return;
    setSubmitError(null);
    const levels = {
      stopLoss: stopLoss.trim() === '' ? null : stopLoss.trim(),
      takeProfit: takeProfit.trim() === '' ? null : takeProfit.trim(),
    };
    try {
      if (orderType === 'MARKET') {
        await open.mutateAsync({ accountId, symbol: symbol.code, side, volume, ...levels });
      } else {
        await place.mutateAsync({
          accountId,
          symbol: symbol.code,
          side,
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
  };

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

      <p className="text-[10px] leading-relaxed text-terminal-muted">
        Costs are estimates from the last quote received here. The server prices the fill against
        the quote current at execution.
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
