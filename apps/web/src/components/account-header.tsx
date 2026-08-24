'use client';

import { cn } from '@tp/ui';
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
}: {
  accountId: string | null;
  account: AccountSummary | undefined;
}) {
  const snapshot = useAccountState(accountId);
  const live = useRealtime((state) => state.account);
  const settings = useAccountSettings(accountId);

  // The live frame wins when it is for this account; otherwise the REST
  // snapshot stands. Both are server valuations, so they cannot disagree about
  // how a number was derived — only about how old it is.
  const state = live !== null && live.accountId === accountId ? live : (snapshot.data ?? null);

  const currency = state?.currency ?? account?.currency ?? 'USD';
  const marginCall = settings.data?.marginCallLevelPercent ?? null;
  const stopOut = settings.data?.stopOutLevelPercent ?? null;

  const marginLevelTone = marginLevelToneOf(state?.marginLevel ?? null, marginCall, stopOut);

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-3 sm:grid-cols-4 lg:grid-cols-7">
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
