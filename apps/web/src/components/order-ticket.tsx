'use client';

import { entrySideOf } from '@tp/financial-core';
import { marketNotice } from '../lib/market-state';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@tp/ui';
import { Permission } from '@tp/shared-types';
import { price as formatPrice, signedMoney, toneClass, toneOf } from '@/lib/format';
import {
  estimateCosts,
  projectedOutcome,
  rewardToRisk,
  riskPercent,
  stepVolume,
  validateTicket,
} from '@/lib/ticket';
import { validateRestingPrice } from '@/lib/ticket';
import {
  COMMAND_STATE_LABEL,
  CommandState,
  rejectionLines,
  settlementFromResponse,
  type OrderCommand,
} from '@/lib/order-commands';
import {
  useAccountState,
  useOpenPosition,
  usePermissions,
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
  const [submitError, setSubmitError] = useState<readonly string[]>([]);
  /** A one-click order awaiting the confirmation the trader asked to keep. */
  const [pendingConfirm, setPendingConfirm] = useState<'BUY' | 'SELL' | null>(null);

  const quote = useRealtime((state) =>
    symbol === undefined ? undefined : state.quotes[symbol.code],
  );
  const commands = useRealtime((state) => state.commands);
  const state = useAccountState(accountId);
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

  const executable = quote === undefined ? null : quote[entrySideOf(side)];
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

  /**
   * What the levels on this ticket would be worth.
   *
   * Measured from the price the order will actually open at: the executable
   * price for a market order, the resting price for one that has to wait. A
   * limit order priced 40 points below the market has a different risk from the
   * same stop measured against today's price, and showing the latter would be
   * arithmetic about an order nobody placed.
   */
  const entryReference = orderType === 'MARKET' ? executable : resting === '' ? null : resting;
  const ifStopped = useMemo(
    () => projectedOutcome(symbol, account, side, volume, entryReference, stopLoss),
    [symbol, account, side, volume, entryReference, stopLoss],
  );
  const ifTargeted = useMemo(
    () => projectedOutcome(symbol, account, side, volume, entryReference, takeProfit),
    [symbol, account, side, volume, entryReference, takeProfit],
  );
  const ratio = useMemo(() => rewardToRisk(ifTargeted, ifStopped), [ifTargeted, ifStopped]);
  /**
   * The projected loss as a share of equity — the number a trader actually
   * manages by. "Two percent" is a rule people follow; "eighty-four dollars"
   * is not, and cannot be compared between two accounts of different sizes.
   */
  const riskShare = useMemo(
    () => riskPercent(ifStopped, account, state.data?.equity),
    [ifStopped, account, state.data?.equity],
  );

  const busy = open.isPending || place.isPending;

  /**
   * What this login may do, asked of the server.
   *
   * This used to be computed locally from the role, with a comment saying the
   * compile-time table was the same one the server enforced with. That was true
   * until grants became rows a tenant can edit, and the failure afterwards would
   * have been silent in the worse direction: a capability an administrator had
   * *removed* would still have had its button here, and the trader would have
   * learnt about it from a refusal after committing to a price.
   *
   * While the answer is still loading the ticket assumes it may trade, because
   * the server refuses anyway and greying the button out on every page load
   * would be a worse lie than the one this replaces.
   */
  const { data: permissions } = usePermissions();
  const mayTrade = useMemo(
    () => permissions === undefined || permissions.permissions.includes(Permission.ORDERS_CREATE),
    [permissions],
  );

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
    /**
     * Checked first, because it is the one condition nothing else can fix.
     *
     * An administrator login carries no `orders.create` — deliberately: it can
     * post to the ledger and change an instrument's margin, and one login that
     * could also trade could credit an account and trade the credit. Saying so
     * here, before the button is pressed, replaces a round trip that ends in
     * "your role does not carry orders.create" — an error that reads like a
     * fault rather than a rule.
     */
    if (!mayTrade) {
      return `Signed in as ${permissions?.role ?? 'this role'}, which cannot place orders. Trading needs a trader login.`;
    }
    if (accountId === null) return 'No account selected.';
    if (symbol === undefined) return 'Select an instrument.';
    if (!symbol.enabled) return `${symbol.code} is not tradeable right now.`;
    if (validation.error !== null) return validation.error;
    if (priceError !== null) return priceError;
    if (executable === null) return 'No price yet for this instrument.';
    return null;
  }, [mayTrade, permissions, accountId, symbol, validation.error, priceError, executable]);

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
        setSubmitError([blockedReason]);
        return;
      }
      setSubmitError([]);
      const levels = {
        stopLoss: stopLoss.trim() === '' ? null : stopLoss.trim(),
        takeProfit: takeProfit.trim() === '' ? null : takeProfit.trim(),
      };

      /**
       * The command id is minted here and handed to the mutation as the
       * idempotency key, rather than minted inside it.
       *
       * That ordering is the point. If the key were minted where the request is
       * sent, there would be a window — short, but real — in which the order was
       * on the wire and this panel could not yet say which attempt it belonged
       * to. Recording the submission *before* it leaves means a trader whose
       * network drops mid-request still has the id to quote.
       */
      const commandId = crypto.randomUUID();
      const store = useRealtime.getState();
      store.startCommand({
        commandId,
        symbol: symbol.code,
        side: requestedSide,
        type: orderType,
        volume,
        at: Date.now(),
      });

      try {
        const response =
          orderType === 'MARKET'
            ? await open.mutateAsync({
                commandId,
                accountId,
                symbol: symbol.code,
                side: requestedSide,
                volume,
                ...levels,
              })
            : await place.mutateAsync({
                commandId,
                accountId,
                symbol: symbol.code,
                side: requestedSide,
                type: orderType,
                volume,
                price: restingPrice.trim(),
                timeInForce,
                ...levels,
              });

        useRealtime
          .getState()
          .settleCommand(commandId, settlementFromResponse(orderType, response, Date.now()));

        if (orderType !== 'MARKET') setRestingPrice('');
        setStopLoss('');
        setTakeProfit('');
      } catch (error) {
        // Every violation, not the first: see `rejectionLines`.
        const lines = rejectionLines(error);
        useRealtime.getState().settleCommand(commandId, {
          state: CommandState.REJECTED,
          // The command log is one row per attempt, so it keeps the primary
          // reason; the ticket below shows all of them.
          reason: lines[0] ?? 'The order was rejected.',
          at: Date.now(),
        });
        setSubmitError(lines);
      }
    },
    [
      accountId,
      symbol,
      blockedReason,
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

    /**
     * Escape and Enter are claimed **only when this panel has something
     * pending**.
     *
     * That matters because the positions panel listens to the same keystroke.
     * A panel that marked every Escape handled would swallow the one the other
     * panel's own confirmation was waiting for, and a confirmation that cannot
     * be dismissed is worse than one that was never asked.
     */
    if (shortcut.action === ShortcutAction.CANCEL) {
      if (pendingConfirm === null) return;
      handledAt.current = shortcut.at;
      onShortcutHandled();
      setPendingConfirm(null);
      return;
    }

    if (shortcut.action === ShortcutAction.CONFIRM) {
      if (pendingConfirm === null) return;
      handledAt.current = shortcut.at;
      onShortcutHandled();
      const requested = pendingConfirm;
      setPendingConfirm(null);
      void send(requested);
      return;
    }

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
  }, [shortcut, preferences.confirm, send, onShortcutHandled, pendingConfirm]);

  /**
   * An order large enough to be worth pausing over (§86).
   *
   * "Large" is measured against the account, not against a number somebody
   * typed into a config file: an order that would commit more than
   * `LARGE_ORDER_MARGIN_SHARE` of free margin, or risk more than
   * `LARGE_ORDER_RISK_SHARE` of equity at its own stop, is one the trader is
   * asked to confirm — whatever their one-click setting says.
   *
   * Measuring it in the account's own terms is what makes it useful on both a
   * five-hundred-dollar account and a five-million-dollar one. A fixed lot
   * threshold would fire constantly on one and never on the other.
   */
  const largeOrder = useMemo(() => {
    const freeMargin = state.data?.freeMargin;
    const marginNeeded = estimate.marginAmount;
    if (freeMargin != null && marginNeeded !== null && Number(freeMargin) > 0) {
      if (Number(marginNeeded) / Number(freeMargin) >= LARGE_ORDER_MARGIN_SHARE) {
        return `This order commits about ${Math.round(
          (Number(marginNeeded) / Number(freeMargin)) * 100,
        )}% of your free margin.`;
      }
    }
    if (riskShare !== null && Number(riskShare) >= LARGE_ORDER_RISK_SHARE * 100) {
      return `This order risks ${riskShare}% of your equity at its stop.`;
    }
    return null;
  }, [state.data?.freeMargin, estimate.marginAmount, riskShare]);

  if (symbol === undefined) {
    return <EmptyState>Select an instrument to trade.</EmptyState>;
  }

  const canSubmit = blockedReason === null && !busy;

  const submit = () => {
    // A large order is confirmed even in one-click mode. One-click is a
    // convenience for ordinary size; it was never a request to skip the one
    // order that could take the account down.
    if (largeOrder !== null && pendingConfirm === null) {
      setPendingConfirm(side);
      return;
    }
    void send(side);
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
        {/*
          Shown only once there is a level to project from. An empty row reading
          "—" beside "If stopped" invites the reading that the stop costs
          nothing, which is the opposite of what a blank means.
        */}
        {ifStopped === null ? null : (
          <EstimateRow
            label="If stopped"
            value={signedMoney(ifStopped, account?.currency ?? 'USD')}
            tone={toneClass[toneOf(ifStopped)]}
            title="Gross, at this stop, from this entry. Commission is above; swap depends on how long it is held."
          />
        )}
        {ifTargeted === null ? null : (
          <EstimateRow
            label="If target hits"
            value={signedMoney(ifTargeted, account?.currency ?? 'USD')}
            tone={toneClass[toneOf(ifTargeted)]}
            title="Gross, at this target, from this entry."
          />
        )}
        {riskShare === null ? null : (
          <EstimateRow
            label="Risk"
            value={`${riskShare}% of equity`}
            tone={Number(riskShare) >= 5 ? 'text-terminal-warning' : undefined}
            title="What this stop would cost, as a share of the account's equity"
          />
        )}
        {ratio === null ? null : (
          <EstimateRow
            label="Reward : risk"
            value={`${ratio} : 1`}
            title="Projected gain divided by projected loss, both gross"
          />
        )}
      </dl>

      {orderType === 'MARKET' ? null : (
        <p className="text-[10px] leading-relaxed text-terminal-muted">
          No margin is held while the order rests. It is checked again when the order fires, and
          rejected if the account cannot carry it then.
        </p>
      )}

      {symbol.sessionOpen ? null : (
        <p className="text-[11px] text-terminal-warning">
          {symbol.market === undefined
            ? `${symbol.code} is outside its trading session.`
            : marketNotice(symbol.market, symbol.code).detail}{' '}
          The server will reject the order.
        </p>
      )}

      <CommandLog commands={commands} />

      {priceError === null ? null : <p className="text-[11px] text-terminal-short">{priceError}</p>}
      {validation.error === null ? null : (
        <p className="text-[11px] text-terminal-short">{validation.error}</p>
      )}
      {submitError.length === 0 ? null : (
        <ul className="space-y-0.5 text-[11px] text-terminal-short" role="alert">
          {submitError.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
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
          {largeOrder === null ? null : (
            <p className="mb-2 text-[11px] text-terminal-warning">{largeOrder}</p>
          )}
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
/**
 * When an order is large enough to be worth a pause.
 *
 * Shares of the account, not absolute sizes: a fixed lot threshold would fire
 * constantly on a small account and never on a large one.
 */
const LARGE_ORDER_MARGIN_SHARE = 0.5;
const LARGE_ORDER_RISK_SHARE = 0.1;

const ORDER_TYPES: readonly OrderType[] = ['MARKET', 'LIMIT', 'STOP'];

function EstimateRow({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: string;
  title?: string;
}) {
  return (
    <div className="flex items-center justify-between" title={title}>
      <dt className="text-terminal-muted">{label}</dt>
      <dd className={cn('numeric', tone ?? 'text-terminal-text')}>{value}</dd>
    </div>
  );
}

/**
 * What became of the orders sent from this browser.
 *
 * The panel a trader looks at after pressing the button. Before this, a
 * submission produced a spinner and then the tables refreshed, leaving them to
 * infer which of the new rows was theirs — which on a fast market with two
 * orders in flight is not something a person can do.
 *
 * `accepted` and `filled` are deliberately different words. A resting order that
 * has been accepted has not filled, and one line that said both would be the
 * single most expensive thing this panel could get wrong.
 */
function CommandLog({ commands }: { commands: readonly OrderCommand[] }) {
  if (commands.length === 0) return null;

  return (
    <div className="rounded border border-terminal-border bg-terminal-bg px-2.5 py-2">
      <p className="mb-1 text-[10px] uppercase tracking-wider text-terminal-muted">Sent</p>
      <ul className="space-y-1">
        {commands.slice(0, 4).map((command) => (
          <li key={command.commandId} className="flex items-baseline justify-between gap-2">
            <span className="numeric truncate text-[11px] text-terminal-text">
              {command.side} {command.volume} {command.symbol}
              {command.type === 'MARKET' ? '' : ` ${command.type}`}
            </span>
            <span
              className={cn('shrink-0 text-[10px]', COMMAND_STATE_TONE[command.state])}
              title={command.reason ?? `Command ${command.commandId}`}
            >
              {COMMAND_STATE_LABEL[command.state]}
            </span>
          </li>
        ))}
      </ul>
      {commands[0]?.reason === null || commands[0]?.reason === undefined ? null : (
        <p className="mt-1 text-[10px] leading-snug text-terminal-short">{commands[0].reason}</p>
      )}
    </div>
  );
}

const COMMAND_STATE_TONE: Record<CommandState, string> = {
  [CommandState.SUBMITTING]: 'text-terminal-muted',
  [CommandState.ACCEPTED]: 'text-terminal-warning',
  [CommandState.EXECUTED]: 'text-terminal-long',
  [CommandState.REJECTED]: 'text-terminal-short',
};

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
