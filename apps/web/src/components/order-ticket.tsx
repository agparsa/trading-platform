'use client';

import { useMemo, useState } from 'react';
import { cn } from '@tp/ui';
import { DomainError } from '@tp/shared-types';
import { price as formatPrice } from '@/lib/format';
import { estimateCosts, stepVolume, validateTicket } from '@/lib/ticket';
import { useOpenPosition, type AccountSummary, type SymbolRow } from '@/lib/queries';
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
  const [volume, setVolume] = useState('0.10');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const quote = useRealtime((state) =>
    symbol === undefined ? undefined : state.quotes[symbol.code],
  );
  const open = useOpenPosition(accountId);

  const executable = quote === undefined ? null : side === 'BUY' ? quote.ask : quote.bid;

  const validation = useMemo(
    () => validateTicket(symbol, side, volume, stopLoss, takeProfit, executable),
    [symbol, side, volume, stopLoss, takeProfit, executable],
  );

  const estimate = useMemo(
    () => estimateCosts(symbol, account, volume, executable, validation.volumeOk),
    [symbol, account, volume, executable, validation.volumeOk],
  );

  if (symbol === undefined) {
    return <EmptyState>Select an instrument to trade.</EmptyState>;
  }

  const canSubmit =
    accountId !== null &&
    validation.error === null &&
    executable !== null &&
    symbol.enabled &&
    !open.isPending;

  const submit = async () => {
    if (accountId === null) return;
    setSubmitError(null);
    try {
      await open.mutateAsync({
        accountId,
        symbol: symbol.code,
        side,
        volume,
        stopLoss: stopLoss.trim() === '' ? null : stopLoss.trim(),
        takeProfit: takeProfit.trim() === '' ? null : takeProfit.trim(),
      });
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
          label="Executable"
          value={executable === null ? '—' : formatPrice(executable, symbol.pricePrecision)}
        />
      </dl>

      {symbol.sessionOpen ? null : (
        <p className="text-[11px] text-terminal-warning">
          {symbol.code} is outside its trading session. The server will reject the order.
        </p>
      )}

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
        {open.isPending ? 'Submitting…' : `${side} ${symbol.code}`}
      </Button>

      <p className="text-[10px] leading-relaxed text-terminal-muted">
        Costs are estimates from the last quote received here. The server prices the fill against
        the quote current at execution.
      </p>
    </div>
  );
}

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
