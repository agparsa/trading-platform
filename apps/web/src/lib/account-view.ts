import type { AccountStateResponse } from './queries';
import type { AccountState } from './realtime-store';

/**
 * The account figures to show, from the two sources that carry them.
 *
 * Both are server valuations produced by the same code path, so they cannot
 * disagree about how a number was derived — only about how old it is, and about
 * which numbers they carry at all.
 *
 * - The socket frame is fresher, and arrives on every valuation.
 * - The REST snapshot is the only source of realized P&L, because nothing about
 *   realized P&L changes on a tick and querying for it twice a second would buy
 *   nothing.
 *
 * Choosing one source wholesale is the obvious thing to write and it is wrong:
 * preferring the frame blanks the trader's realized P&L the instant the first
 * tick lands, and preferring the snapshot freezes equity between refetches.
 * Spreading the frame over the snapshot takes the fresher value for every field
 * the frame has and leaves the snapshot's value for the fields it does not —
 * which is the same "absent is not zero" rule the store applies between frames,
 * one layer up.
 */
export function accountView(
  accountId: string | null,
  snapshot: AccountStateResponse | undefined,
  live: AccountState | null,
): Partial<AccountStateResponse> | null {
  const fresh = live !== null && live.accountId === accountId ? live : null;
  const stored = snapshot !== undefined && snapshot.accountId === accountId ? snapshot : null;

  if (fresh === null) return stored;
  if (stored === null) return fresh;
  return { ...stored, ...fresh };
}
