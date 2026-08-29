'use client';

import { cn } from '@tp/ui';
import { accountView } from '@/lib/account-view';
import { money, percent, signedMoney, toneClass, toneOf } from '@/lib/format';
import { useAccountSettings, useAccountState, type AccountSummary } from '@/lib/queries';
import { useRealtime } from '@/lib/realtime-store';
import { Stat } from './primitives';

/**
 * The account strip.
 *
 * Every figure here is produced by the server's valuation, either in the REST
 * snapshot or in an `account.updated` frame — the two come from the same code
 * path. Nothing is derived in the browser: equity that the trader can see but
 * the server never computed is a number nobody can reconcile after a dispute.
 */
export function AccountHeader({
  accountId,
  account,
  openPositions,
  openOrders,
}: {
  accountId: string | null;
  account: AccountSummary | undefined;
  /** Undefined until the list has loaded — an em dash, never a zero. */
  openPositions: number | undefined;
  openOrders: number | undefined;
}) {
  const snapshot = useAccountState(accountId);
  const live = useRealtime((state) => state.account);
  const settings = useAccountSettings(accountId);

  // The frame's values over the snapshot's, field by field rather than
  // wholesale — the snapshot is the only source of realized P&L, and taking
  // the frame whole would blank it from the first tick onwards. See
  // lib/account-view.ts, which is where that rule is tested.
  const state = accountView(accountId, snapshot.data, live);

  const currency = state?.currency ?? account?.currency ?? 'USD';
  const marginCall = settings.data?.marginCallLevelPercent ?? null;
  const stopOut = settings.data?.stopOutLevelPercent ?? null;

  const marginLevelTone = marginLevelToneOf(state?.marginLevel ?? null, marginCall, stopOut);

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-3 sm:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-10">
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wider text-terminal-muted">Account</p>
        <p className="numeric mt-0.5 truncate text-sm text-terminal-text">
          {account === undefined ? '—' : `#${account.number}`}
        </p>
      </div>
      <Stat label="Balance" value={money(state?.balance, currency)} />
      <Stat label="Equity" value={money(state?.equity, currency)} />
      <Stat
        label="Floating P&L"
        value={signedMoney(state?.floatingPnl, currency)}
        tone={toneClass[toneOf(state?.floatingPnl)]}
      />
      {/*
        Realized P&L arrives with the REST snapshot and is carried across tick
        frames by the store. An em dash means "not loaded yet", never "zero" —
        the two are different claims and only one of them is ever true here.
      */}
      <Stat
        label="Realized today"
        value={
          state?.realizedPnlToday === undefined
            ? '—'
            : signedMoney(state.realizedPnlToday, currency)
        }
        tone={toneClass[toneOf(state?.realizedPnlToday ?? null)]}
        title={
          state?.realizedSince === undefined
            ? undefined
            : `Closed trades since ${new Date(state.realizedSince).toISOString().replace('T', ' ').slice(0, 16)} UTC`
        }
      />
      <Stat label="Used margin" value={money(state?.usedMargin, currency)} />
      <Stat label="Free margin" value={money(state?.freeMargin, currency)} />
      <Stat
        label="Margin level"
        value={state?.marginLevel === null ? 'n/a' : percent(state?.marginLevel)}
        tone={marginLevelTone}
        title={
          marginCall === null || stopOut === null
            ? undefined
            : `Margin call at ${marginCall}%, stop-out at ${stopOut}%`
        }
      />
      <Stat
        label="Utilisation"
        value={state?.marginUtilisation == null ? 'n/a' : percent(state.marginUtilisation)}
        title="Margin in use as a share of equity"
      />
      <Stat
        label="Exposure"
        value={money(state?.grossExposure, currency)}
        title="Gross notional across open positions, in account currency"
      />
      {/*
        Counts, not money — and they come from the same lists the panels below
        render, so the header can never disagree with the table a trader is
        looking at. A count derived from a second source is a count that starts
        arguing with the first one.
      */}
      <Stat
        label="Positions"
        value={openPositions === undefined ? '—' : String(openPositions)}
        title="Open positions"
      />
      <Stat
        label="Orders"
        value={openOrders === undefined ? '—' : String(openOrders)}
        title="Resting orders waiting to trigger"
      />
    </div>
  );
}

/**
 * Colours the margin level against the account's own thresholds.
 *
 * `null` means no margin is in use, which is not a warning — it is the absence
 * of a ratio. Painting it red would say the opposite of the truth.
 */
function marginLevelToneOf(
  level: string | null,
  marginCall: string | null,
  stopOut: string | null,
): string {
  if (level === null || marginCall === null || stopOut === null) return 'text-terminal-text';
  const value = Number(level);
  if (!Number.isFinite(value)) return 'text-terminal-text';
  if (value <= Number(stopOut)) return cn('text-terminal-short font-medium');
  if (value <= Number(marginCall)) return 'text-terminal-warning';
  return 'text-terminal-text';
}
