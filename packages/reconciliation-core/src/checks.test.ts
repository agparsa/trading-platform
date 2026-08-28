import { describe, expect, it } from 'vitest';
import { reconcileAccount } from './checks';
import { CheckCode, Severity, type AccountRecords } from './types';

/**
 * Reconciliation is tested by breaking the books.
 *
 * Each case starts from an account whose records agree and then damages exactly
 * one thing — a balance a cent out, a trade with no ledger entry behind it, a
 * position holding volume its executions never opened. A check that cannot be
 * made to fire is not a check.
 *
 * The first test is the one that makes the rest mean anything: a *correct*
 * account must produce no findings at all. An engine that flags everything is
 * indistinguishable from an engine that flags nothing.
 */

/**
 * One deposit, one closed round trip, one open position.
 *
 * ```
 * DEPOSIT      +100000.00
 * COMMISSION       -7.00   opening the position that was later closed
 * TRADE_PROFIT   +250.00
 * COMMISSION       -7.00   closing it
 * COMMISSION      -10.00   opening the position still held
 * SWAP             -2.50   accrued on the position still held
 *              ───────────
 *               100223.50
 * ```
 */
function balanced(): AccountRecords {
  return {
    accountId: 'acct-1',
    number: 'TP-100001',
    currency: 'USD',
    storedBalance: '100223.50',
    ledger: {
      all: '100223.50',
      tradeResult: '250.00',
      commission: '-24.00',
      swap: '-2.50',
    },
    orders: [
      {
        id: 'o1',
        status: 'FILLED',
        volume: '1',
        filledVolume: '1',
        positionId: 'p1',
        executionCount: 1,
      },
      {
        id: 'o2',
        status: 'FILLED',
        volume: '1',
        filledVolume: '1',
        positionId: 'p1',
        executionCount: 1,
      },
      {
        id: 'o3',
        status: 'FILLED',
        volume: '2',
        filledVolume: '2',
        positionId: 'p2',
        executionCount: 1,
      },
      // A resting order with no execution is an order waiting for its price.
      {
        id: 'o4',
        status: 'PENDING',
        volume: '1',
        filledVolume: '0',
        positionId: null,
        executionCount: 0,
      },
      {
        id: 'o5',
        status: 'CANCELLED',
        volume: '1',
        filledVolume: '0',
        positionId: null,
        executionCount: 0,
      },
    ],
    positions: [
      {
        id: 'p1',
        status: 'CLOSED',
        volume: '0',
        initialVolume: '1',
        commission: '7.00',
        swap: '0.00',
        realizedPnl: '236.00',
        openingExecutedVolume: '1',
        closingExecutedVolume: '1',
      },
      {
        id: 'p2',
        status: 'OPEN',
        volume: '2',
        initialVolume: '2',
        commission: '10.00',
        swap: '-2.50',
        realizedPnl: '0.00',
        openingExecutedVolume: '2',
        closingExecutedVolume: '0',
      },
    ],
    trades: [
      {
        id: 't1',
        positionId: 'p1',
        grossPnl: '250.00',
        commission: '14.00',
        entryCommission: '7.00',
        exitCommission: '7.00',
        swap: '0.00',
        netPnl: '236.00',
        ledgerEntryCount: 3,
      },
    ],
  };
}

function codesFor(records: AccountRecords): string[] {
  return reconcileAccount(records).findings.map((f) => f.code);
}

describe('a correct account', () => {
  /**
   * The test the whole suite rests on. An engine that flags a healthy account is
   * an engine whose alerts nobody reads, and by the time it flags a real one it
   * has already trained everybody to ignore it.
   */
  it('produces no findings at all', () => {
    expect(reconcileAccount(balanced()).findings).toEqual([]);
  });

  it('does not mistake a resting or cancelled order for a missing execution', () => {
    const records = balanced();
    expect(codesFor(records)).not.toContain(CheckCode.FILLED_ORDER_WITHOUT_EXECUTION);
  });

  /**
   * An open position has already paid its entry commission and accrued swap,
   * and no trade row reports either yet. An engine that forgot this would flag
   * every account holding a position, for exactly the costs it had legitimately
   * paid.
   */
  it('does not flag an account merely for holding an open position', () => {
    const records = balanced();
    expect(codesFor(records)).not.toContain(CheckCode.REALIZED_PNL_MISMATCH);
    expect(codesFor(records)).not.toContain(CheckCode.COMMISSION_MISMATCH);
    expect(codesFor(records)).not.toContain(CheckCode.SWAP_MISMATCH);
  });
});

describe('a balance not backed by the ledger', () => {
  it('is detected, and reported as critical', () => {
    const records = { ...balanced(), storedBalance: '100224.50' };
    const report = reconcileAccount(records);
    const drift = report.findings.find((f) => f.code === CheckCode.LEDGER_DRIFT);
    expect(drift?.severity).toBe(Severity.CRITICAL);
    expect(drift?.expected).toBe('100223.5');
    expect(drift?.actual).toBe('100224.5');
    expect(drift?.difference).toBe('1');
  });

  /** A cent is the size the real bug was, so a cent has to be detectable. */
  it('is detected at one cent', () => {
    const records = { ...balanced(), storedBalance: '100223.51' };
    expect(codesFor(records)).toContain(CheckCode.LEDGER_DRIFT);
  });
});

describe('a filled order with no execution', () => {
  it('is detected', () => {
    const records = balanced();
    const orders = records.orders.map((o) => (o.id === 'o1' ? { ...o, executionCount: 0 } : o));
    const report = reconcileAccount({ ...records, orders });
    const found = report.findings.find((f) => f.code === CheckCode.FILLED_ORDER_WITHOUT_EXECUTION);
    expect(found?.subjectId).toBe('o1');
    expect(found?.severity).toBe(Severity.CRITICAL);
  });
});

describe('a position with no opening execution', () => {
  it('is detected', () => {
    const records = balanced();
    const positions = records.positions.map((p) =>
      p.id === 'p2' ? { ...p, openingExecutedVolume: '0' } : p,
    );
    expect(codesFor({ ...records, positions })).toContain(
      CheckCode.POSITION_WITHOUT_OPENING_EXECUTION,
    );
  });
});

describe('a position holding volume its executions never opened', () => {
  it('is detected', () => {
    const records = balanced();
    const positions = records.positions.map((p) => (p.id === 'p2' ? { ...p, volume: '3' } : p));
    const report = reconcileAccount({ ...records, positions });
    const found = report.findings.find((f) => f.code === CheckCode.POSITION_VOLUME_MISMATCH);
    expect(found?.expected).toBe('2');
    expect(found?.actual).toBe('3');
  });

  /** A close that wrote a trade but never reduced the position. */
  it('is detected when a close did not reduce the position', () => {
    const records = balanced();
    const positions = records.positions.map((p) =>
      p.id === 'p1' ? { ...p, volume: '1', status: 'OPEN' } : p,
    );
    expect(codesFor({ ...records, positions })).toContain(CheckCode.POSITION_VOLUME_MISMATCH);
  });
});

describe('a trade with nothing in the ledger behind it', () => {
  it('is detected', () => {
    const records = balanced();
    const trades = records.trades.map((t) => ({ ...t, ledgerEntryCount: 0 }));
    expect(codesFor({ ...records, trades })).toContain(CheckCode.TRADE_WITHOUT_LEDGER_ENTRY);
  });
});

describe('a trade report that disagrees with what the ledger paid', () => {
  /**
   * This is the check that would have caught the real defect: `netPnl` computed
   * by rounding a sum, while the ledger moved by a sum of separately-rounded
   * postings. One cent, per trade, silently.
   */
  it('is detected at one cent', () => {
    const records = balanced();
    const trades = records.trades.map((t) => ({ ...t, netPnl: '236.01' }));
    const report = reconcileAccount({ ...records, trades });
    const found = report.findings.find((f) => f.code === CheckCode.REALIZED_PNL_MISMATCH);
    expect(found?.severity).toBe(Severity.CRITICAL);
    expect(found?.difference).toBe('0.01');
  });

  it('is detected when the ledger paid something the trades never claimed', () => {
    const records = balanced();
    expect(
      codesFor({ ...records, ledger: { ...records.ledger, tradeResult: '260.00' } }),
    ).toContain(CheckCode.REALIZED_PNL_MISMATCH);
  });
});

describe('commission and swap', () => {
  it('detects commission the ledger charged but no record claims', () => {
    const records = balanced();
    const found = reconcileAccount({
      ...records,
      ledger: { ...records.ledger, commission: '-30.00' },
    }).findings.find((f) => f.code === CheckCode.COMMISSION_MISMATCH);
    expect(found?.expected).toBe('30');
    expect(found?.actual).toBe('24');
  });

  it('detects swap a record claims but the ledger never posted', () => {
    const records = balanced();
    const trades = records.trades.map((t) => ({ ...t, swap: '-5.00' }));
    expect(codesFor({ ...records, trades })).toContain(CheckCode.SWAP_MISMATCH);
  });

  /** Swap can be a credit, and a credit is not a discrepancy. */
  it('accepts a positive swap that both sides agree on', () => {
    const records = balanced();
    const positions = records.positions.map((p) => (p.id === 'p2' ? { ...p, swap: '4.75' } : p));
    const ledger = { ...records.ledger, swap: '4.75', all: '100230.75' };
    expect(
      reconcileAccount({ ...records, positions, ledger, storedBalance: '100230.75' }).findings,
    ).toEqual([]);
  });
});

describe('an empty account', () => {
  it('reconciles cleanly rather than dividing by nothing', () => {
    const empty: AccountRecords = {
      accountId: 'acct-2',
      number: 'TP-100002',
      currency: 'USD',
      storedBalance: '0',
      ledger: { all: '0', tradeResult: '0', commission: '0', swap: '0' },
      orders: [],
      positions: [],
      trades: [],
    };
    expect(reconcileAccount(empty).findings).toEqual([]);
  });
});

describe('several faults at once', () => {
  /**
   * A broken account rarely breaks in one place, and the report has to name each
   * one — an engine that stopped at the first would hide the rest behind it.
   */
  it('reports every one of them, worst first', () => {
    const records = balanced();
    const report = reconcileAccount({
      ...records,
      storedBalance: '99999.99',
      trades: records.trades.map((t) => ({ ...t, ledgerEntryCount: 0, netPnl: '999.99' })),
    });
    expect(report.findings.map((f) => f.code)).toContain(CheckCode.LEDGER_DRIFT);
    expect(report.findings.map((f) => f.code)).toContain(CheckCode.REALIZED_PNL_MISMATCH);
    expect(report.findings.map((f) => f.code)).toContain(CheckCode.TRADE_WITHOUT_LEDGER_ENTRY);
    expect(report.findings[0]?.code).toBe(CheckCode.LEDGER_DRIFT);
  });
});
