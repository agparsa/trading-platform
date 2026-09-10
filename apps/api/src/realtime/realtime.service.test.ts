import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeService } from './realtime.service';

/**
 * The valuation pass's time budget.
 *
 * At a thousand connected accounts a pass valued a thousand screens back to
 * back with itself, and orders queued behind it for minutes. What is pinned:
 * a pass stops taking accounts once it has used its budget, counts what it
 * left, and the next pass takes the deferred accounts first — so under load
 * every screen refreshes less often rather than some screens never.
 */

const TENANT = { tenantId: '11111111-1111-1111-1111-111111111111', slug: 't' };
const accountIds = Array.from({ length: 20 }, (_, i) => `acct-${String(i).padStart(2, '0')}`);

function build(budgetMs: number, valuationCostMs: number) {
  const valued: string[] = [];
  const deferred: number[] = [];
  const config = {
    getOrThrow: (key: string) =>
      ({ REALTIME_VALUATION_INTERVAL_MS: 0, REALTIME_VALUATION_BUDGET_MS: budgetMs })[key],
  };
  const accountState = {
    valuate: async (accountId: string) => {
      valued.push(accountId);
      // The read goes to the database first — so every worker in the window
      // has taken its account before any cost lands — and then the decimal
      // arithmetic over the book costs this much of the clock.
      await Promise.resolve();
      vi.advanceTimersByTime(valuationCostMs);
      return { positions: [], state: { marginLevel: null } };
    },
    toDto: () => ({}),
  };
  const gateway = {
    tenantsOfListeners: () => [{ tenant: TENANT, accounts: new Set(accountIds) }],
    sendToAccount: () => 1,
    onAccountAbandoned: () => () => undefined,
  };
  const exposure = { exposedTo: async (_symbol: string, accounts: Set<string>) => [...accounts] };
  const prisma = {
    account: {
      findUnique: async () => ({
        marginCallLevel: null,
        stopOutLevel: null,
        userId: null,
        accountNumber: null,
      }),
    },
  };
  const metrics = {
    tickToPnl: { observe: () => undefined },
    tickToSocket: { observe: () => undefined },
    realtimePassLag: { observe: () => undefined },
    realtimeDeferred: { inc: (n: number) => deferred.push(n) },
  };
  const service = new RealtimeService(
    config as never,
    prisma as never,
    accountState as never,
    gateway as never,
    { subscribe: () => () => undefined } as never,
    exposure as never,
    {} as never,
    metrics as never,
  );
  return { service, valued, deferred };
}

describe('RealtimeService valuation budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops taking accounts once the budget is spent, counts the rest, and takes them first next time', async () => {
    // 20 accounts, 8 at a time, each costing 30 ms against a 20 ms budget: the
    // first eight start inside the budget, and nothing else does.
    const { service, valued, deferred } = build(20, 30);
    service.onTick({ symbol: 'XAUUSD', bid: '1', ask: '1', timestamp: Date.now(), volume: '1' });

    await service.drain(Date.now());
    expect(valued).toHaveLength(8);
    expect(deferred).toEqual([12]);

    // Next pass: the twelve that waited come first — oldest first is what
    // keeps a screen from starving — and the budget bites again.
    const firstPass = new Set(valued);
    valued.length = 0;
    vi.advanceTimersByTime(500);
    service.onTick({ symbol: 'XAUUSD', bid: '1', ask: '1', timestamp: Date.now(), volume: '1' });
    await service.drain(Date.now());
    expect(valued).toHaveLength(8);
    expect(valued.every((id) => !firstPass.has(id))).toBe(true);
    expect(deferred).toEqual([12, 12]);
  });

  it('values everything that is due when the budget allows', async () => {
    const { service, valued, deferred } = build(10_000, 1);
    service.onTick({ symbol: 'XAUUSD', bid: '1', ask: '1', timestamp: Date.now(), volume: '1' });
    await service.drain(Date.now());
    expect(valued).toHaveLength(20);
    expect(deferred).toEqual([]);
  });
});
