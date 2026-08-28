'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@tp/ui';
import { DomainError } from '@tp/shared-types';
import {
  money,
  price as formatPrice,
  signedMoney,
  toneClass,
  toneOf,
  volume as formatVolume,
} from '@/lib/format';
import {
  useClosePosition,
  useModifyPosition,
  useReversePosition,
  type AccountStateResponse,
  type PositionRow,
  type SymbolRow,
} from '@/lib/queries';
import { useRealtime } from '@/lib/realtime-store';
import { ShortcutAction, needsConfirmation } from '@/lib/shortcuts';
import type { TradingPreferences } from '@/lib/trading-preferences';
import { Button, EmptyState, SideBadge, inputClass } from './primitives';

/**
 * Open positions.
 *
 * The rows come from REST; the P&L column comes from the socket. Splitting them
 * that way means a dropped frame makes one number briefly stale instead of
 * making a position disappear from a trader's screen while it is still open.
 */
export function PositionsPanel({
  positions,
  symbols,
  accountId,
  currency,
  snapshot,
  preferences,
  shortcut,
  onShortcutHandled,
}: {
  positions: readonly PositionRow[];
  symbols: readonly SymbolRow[];
  accountId: string | null;
  currency: string;
  snapshot: AccountStateResponse | undefined;
  preferences: TradingPreferences;
  shortcut: { action: ShortcutAction; at: number } | null;
  onShortcutHandled: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const livePnl = useRealtime((state) => state.pnl);
  const closeOne = useClosePosition(accountId);
  const [prompt, setPrompt] = useState<ClosePrompt | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const handledAt = useRef<number>(0);

  /**
   * Which position `close` means.
   *
   * The expanded row if there is one, otherwise the only position if there is
   * only one. Anything else is **ambiguous, and ambiguity is not resolved by
   * guessing** — closing the wrong position is not a mistake a trader can undo
   * at the same price. They are told to pick one instead.
   */
  const closeTarget = useMemo(() => {
    if (editing !== null) return positions.find((p) => p.id === editing) ?? null;
    return positions.length === 1 ? (positions[0] ?? null) : null;
  }, [editing, positions]);

  useEffect(() => {
    if (shortcut === null || shortcut.at === handledAt.current) return;
    if (shortcut.action !== ShortcutAction.CLOSE && shortcut.action !== ShortcutAction.CLOSE_ALL) {
      return;
    }
    handledAt.current = shortcut.at;
    onShortcutHandled();
    setNotice(null);

    if (shortcut.action === ShortcutAction.CLOSE_ALL) {
      if (positions.length === 0) return;
      // Always asked about, whatever the one-click setting says. See
      // `needsConfirmation`.
      setPrompt({ kind: 'ALL', count: positions.length });
      return;
    }

    if (closeTarget === null) {
      setNotice(
        positions.length === 0
          ? 'Nothing to close.'
          : 'Several positions are open — expand the one you mean, then press close again.',
      );
      return;
    }
    if (needsConfirmation(ShortcutAction.CLOSE, preferences.confirm)) {
      setPrompt({ kind: 'ONE', position: closeTarget });
      return;
    }
    void closeOne.mutateAsync({ positionId: closeTarget.id, volume: null }).catch(() => {
      setNotice('The close request failed. The position is unchanged.');
    });
  }, [shortcut, closeTarget, positions, preferences.confirm, closeOne, onShortcutHandled]);

  const runPrompt = async () => {
    if (prompt === null) return;
    const targets = prompt.kind === 'ALL' ? positions : [prompt.position];
    setPrompt(null);
    for (const target of targets) {
      try {
        await closeOne.mutateAsync({ positionId: target.id, volume: null });
      } catch {
        // Each position is closed on its own request, so one refusal does not
        // strand the rest. Whatever is left is still on screen, still closable.
        setNotice('At least one position could not be closed. Check the list.');
      }
    }
  };

  const specs = useMemo(
    () => Object.fromEntries(symbols.map((symbol) => [symbol.code, symbol])),
    [symbols],
  );
  const snapshotPnl = useMemo(
    () => Object.fromEntries((snapshot?.positions ?? []).map((p) => [p.positionId, p])),
    [snapshot],
  );

  if (positions.length === 0) {
    return (
      <>
        {notice === null ? null : <Notice text={notice} onDismiss={() => setNotice(null)} />}
        <EmptyState>No open positions.</EmptyState>
      </>
    );
  }

  return (
    <>
      {notice === null ? null : <Notice text={notice} onDismiss={() => setNotice(null)} />}
      {prompt === null ? null : (
        <ConfirmClose
          prompt={prompt}
          onConfirm={() => void runPrompt()}
          onCancel={() => setPrompt(null)}
        />
      )}
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-terminal-surface">
          <tr className="text-left text-[10px] uppercase tracking-wider text-terminal-muted">
            <th className="px-3 py-1.5 font-medium">Symbol</th>
            <th className="px-2 py-1.5 font-medium">Side</th>
            <th className="px-2 py-1.5 text-right font-medium">Volume</th>
            <th className="px-2 py-1.5 text-right font-medium">Entry</th>
            <th className="px-2 py-1.5 text-right font-medium">Current</th>
            <th className="px-2 py-1.5 text-right font-medium">S/L</th>
            <th className="px-2 py-1.5 text-right font-medium">T/P</th>
            <th className="px-2 py-1.5 text-right font-medium">Swap</th>
            <th className="px-2 py-1.5 text-right font-medium">P&amp;L</th>
            <th className="px-2 py-1.5 text-right font-medium">Net P&amp;L</th>
            <th className="px-3 py-1.5 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => {
            const spec = specs[position.symbol];
            const precision = spec?.pricePrecision ?? 2;
            const live = livePnl[position.id];
            const fallback = snapshotPnl[position.id];
            const pnl = live?.floatingPnl ?? fallback?.floatingPnl ?? null;
            // Also from the server. Net is the mark less the commission and swap
            // already charged to this position — not a projection of the round
            // trip, and not something the browser subtracts for itself.
            const netPnl = live?.netPnl ?? fallback?.netPnl ?? null;
            const current = live?.currentPrice ?? fallback?.currentPrice ?? position.currentPrice;
            const stale = live?.stale ?? fallback?.stale ?? false;

            return (
              <Fragment key={position.id}>
                <tr className="border-t border-terminal-border/60 hover:bg-terminal-raised/40">
                  <td className="px-3 py-1.5 font-medium text-terminal-text">{position.symbol}</td>
                  <td className="px-2 py-1.5">
                    <SideBadge side={position.side} />
                  </td>
                  <td className="numeric px-2 py-1.5 text-right text-terminal-text">
                    {formatVolume(position.volume)}
                  </td>
                  <td className="numeric px-2 py-1.5 text-right text-terminal-muted">
                    {formatPrice(position.entryPrice, precision)}
                  </td>
                  <td
                    className={cn(
                      'numeric px-2 py-1.5 text-right',
                      stale ? 'text-terminal-warning' : 'text-terminal-text',
                    )}
                    title={stale ? 'This price is older than the freshness limit' : undefined}
                  >
                    {formatPrice(current, precision)}
                  </td>
                  <td className="numeric px-2 py-1.5 text-right text-terminal-muted">
                    {position.stopLoss === null ? '—' : formatPrice(position.stopLoss, precision)}
                    {position.trailingStopDistance === null ? null : (
                      <span
                        className="ml-1 text-[9px] uppercase text-terminal-warning"
                        title="Trailing"
                      >
                        trl
                      </span>
                    )}
                  </td>
                  <td className="numeric px-2 py-1.5 text-right text-terminal-muted">
                    {position.takeProfit === null
                      ? '—'
                      : formatPrice(position.takeProfit, precision)}
                  </td>
                  <td
                    className={cn(
                      'numeric px-2 py-1.5 text-right',
                      toneClass[toneOf(position.swap)],
                    )}
                  >
                    {money(position.swap, currency)}
                  </td>
                  <td className={cn('numeric px-2 py-1.5 text-right', toneClass[toneOf(pnl)])}>
                    {signedMoney(pnl, currency)}
                  </td>
                  <td
                    className={cn('numeric px-2 py-1.5 text-right', toneClass[toneOf(netPnl)])}
                    title="Mark less the commission and swap already charged. The closing commission has not been charged and is not guessed at."
                  >
                    {signedMoney(netPnl, currency)}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Button
                      variant="ghost"
                      onClick={() => setEditing(editing === position.id ? null : position.id)}
                      className="px-2 py-0.5"
                    >
                      {editing === position.id ? 'Close panel' : 'Manage'}
                    </Button>
                  </td>
                </tr>
                {editing === position.id ? (
                  <tr className="border-t border-terminal-border/60">
                    <td colSpan={11} className="bg-terminal-bg px-3 py-3">
                      <PositionEditor
                        position={position}
                        spec={spec}
                        accountId={accountId}
                        onDone={() => setEditing(null)}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

type ClosePrompt = { kind: 'ONE'; position: PositionRow } | { kind: 'ALL'; count: number };

function Notice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <button
      type="button"
      onClick={onDismiss}
      className="w-full border-b border-terminal-border bg-terminal-raised/60 px-3 py-1 text-left text-[11px] text-terminal-warning"
    >
      {text} — dismiss
    </button>
  );
}

/**
 * The question asked before a keyboard close.
 *
 * It names what will happen — this position, or this many positions — rather
 * than asking whether the trader is sure. "Are you sure?" is answerable without
 * reading it; "Close all 4 positions?" is not.
 */
function ConfirmClose({
  prompt,
  onConfirm,
  onCancel,
}: {
  prompt: ClosePrompt;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-terminal-warning/50 bg-terminal-warning/10 px-3 py-2">
      <span className="text-[11px] text-terminal-text">
        {prompt.kind === 'ALL'
          ? `Close all ${prompt.count} position${prompt.count === 1 ? '' : 's'} at market?`
          : `Close ${formatVolume(prompt.position.volume)} ${prompt.position.symbol} at market?`}
      </span>
      <Button variant="danger" onClick={onConfirm} className="px-2 py-0.5">
        Close
      </Button>
      <Button variant="ghost" onClick={onCancel} className="px-2 py-0.5">
        Cancel
      </Button>
    </div>
  );
}

/**
 * Per-position actions.
 *
 * Each action is a separate request with its own idempotency key, and each
 * reports its own failure. A failed partial close must not leave the trader
 * believing a modify succeeded, so nothing here is batched.
 */
function PositionEditor({
  position,
  spec,
  accountId,
  onDone,
}: {
  position: PositionRow;
  spec: SymbolRow | undefined;
  accountId: string | null;
  onDone: () => void;
}) {
  const [partial, setPartial] = useState('');
  const [stopLoss, setStopLoss] = useState(position.stopLoss ?? '');
  const [takeProfit, setTakeProfit] = useState(position.takeProfit ?? '');
  const [trailing, setTrailing] = useState(position.trailingStopDistance ?? '');
  const [error, setError] = useState<string | null>(null);

  const close = useClosePosition(accountId);
  const modify = useModifyPosition(accountId);
  const reverse = useReversePosition(accountId);

  const busy = close.isPending || modify.isPending || reverse.isPending;

  const run = async (action: () => Promise<unknown>, done: boolean) => {
    setError(null);
    try {
      await action();
      if (done) onDone();
    } catch (caught) {
      setError(
        caught instanceof DomainError ? caught.message : 'The request failed. Nothing was changed.',
      );
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Button
          variant="danger"
          disabled={busy}
          onClick={() =>
            void run(() => close.mutateAsync({ positionId: position.id, volume: null }), true)
          }
        >
          Close {formatVolume(position.volume)}
        </Button>

        <div className="flex items-end gap-1">
          <input
            className={cn(inputClass, 'w-24')}
            placeholder={`≤ ${position.volume}`}
            inputMode="decimal"
            value={partial}
            onChange={(event) => setPartial(event.target.value)}
          />
          <Button
            variant="neutral"
            disabled={busy || partial.trim() === ''}
            onClick={() =>
              void run(
                () => close.mutateAsync({ positionId: position.id, volume: partial.trim() }),
                false,
              )
            }
          >
            Close part
          </Button>
        </div>

        <Button
          variant="neutral"
          disabled={busy}
          onClick={() => void run(() => reverse.mutateAsync({ positionId: position.id }), true)}
          title="Close this position and open the same size the other way"
        >
          Reverse
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <LabelledInput label="Stop loss" value={stopLoss} onChange={setStopLoss} />
        <LabelledInput label="Take profit" value={takeProfit} onChange={setTakeProfit} />
        <LabelledInput
          label="Trailing distance"
          value={trailing}
          onChange={setTrailing}
          title="Distance in price units the stop follows behind the best price seen"
        />
        <Button
          variant="neutral"
          disabled={busy}
          onClick={() =>
            void run(
              () =>
                modify.mutateAsync({
                  positionId: position.id,
                  // An empty field clears the level; the API distinguishes null
                  // from omitted, so clearing is explicit rather than implied.
                  stopLoss: stopLoss.trim() === '' ? null : stopLoss.trim(),
                  takeProfit: takeProfit.trim() === '' ? null : takeProfit.trim(),
                  trailingStopDistance: trailing.trim() === '' ? null : trailing.trim(),
                }),
              false,
            )
          }
        >
          Apply levels
        </Button>
      </div>

      <p className="text-[10px] text-terminal-muted">
        Opened {new Date(position.openedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC ·
        margin {position.margin} · commission {position.commission}
        {spec === undefined ? '' : ` · tick ${spec.tickSize}`}
      </p>

      {error === null ? null : <p className="text-[11px] text-terminal-short">{error}</p>}
    </div>
  );
}

function LabelledInput({
  label,
  value,
  onChange,
  title,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  title?: string;
}) {
  return (
    <label className="block" title={title}>
      <span className="mb-1 block text-[10px] uppercase tracking-wider text-terminal-muted">
        {label}
      </span>
      <input
        className={cn(inputClass, 'w-32')}
        placeholder="—"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
