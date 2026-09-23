import { describe, expect, it } from 'vitest';
import {
  compareBalance,
  compareExecutions,
  compareFeeTotals,
  compareOrders,
  comparePositions,
  ItemStatus,
  needsAttention,
  tally,
  type ExternalExecution,
  type ExternalOrder,
  type ExternalPosition,
  type InternalExecution,
  type InternalOrder,
  type InternalPosition,
} from './external';

const statuses = (items: readonly { status: string }[]) => items.map((item) => item.status);
const only = <T>(items: readonly T[]): T => {
  expect(items).toHaveLength(1);
  return items[0] as T;
};

describe('balances against the venue', () => {
  const ours = { accountNumber: 'TP-1', currency: 'USD', balance: '10000.00', equity: '10125.50' };

  it('matches when both sides agree', () => {
    const item = only(
      compareBalance(ours, { currency: 'USD', balance: '10000.00', equity: '10125.50' }),
    );
    expect(item.status).toBe(ItemStatus.MATCHED);
  });

  /** The cent deliberately wrong in it. */
  it('reports a balance that is a cent out', () => {
    const items = compareBalance(ours, {
      currency: 'USD',
      balance: '9999.99',
      equity: '10125.50',
    });
    const item = only(items);
    expect(item.status).toBe(ItemStatus.BALANCE_MISMATCH);
    expect(item.field).toBe('balance');
    expect(item.difference).toBe('0.01');
    expect(item.tolerance).toBeNull();
  });

  it('reports balance and equity separately when both are out', () => {
    const items = compareBalance(ours, { currency: 'USD', balance: '1', equity: '2' });
    expect(items.map((item) => item.field)).toEqual(['balance', 'equity']);
  });

  /**
   * A tolerance is a decision somebody made, and it is recorded on the item so
   * a reader can tell "these agreed" from "these were close enough by a rule".
   */
  it('honours a stated tolerance and says it applied one', () => {
    const within = compareBalance(
      ours,
      { currency: 'USD', balance: '9999.99', equity: '10125.50' },
      { balance: '0.01' },
    );
    expect(only(within).status).toBe(ItemStatus.MATCHED);

    const beyond = compareBalance(
      ours,
      { currency: 'USD', balance: '9999.90', equity: '10125.50' },
      { balance: '0.01' },
    );
    expect(only(beyond).tolerance).toBe('0.01');
  });

  /**
   * Two numbers in different currencies do not differ by their subtraction, and
   * reporting that they do would be a number worse than no number.
   */
  it('refuses to subtract across currencies', () => {
    const item = only(
      compareBalance(ours, { currency: 'EUR', balance: '9000.00', equity: '9000.00' }),
    );
    expect(item.status).toBe(ItemStatus.UNKNOWN);
    expect(item.field).toBe('currency');
    expect(item.difference).toBeNull();
  });

  /**
   * An item nobody could compare is not an item that agrees. Calling it one is
   * how a report comes back clean on the day the venue starts sending blanks.
   */
  it('does not call an uncomparable field matched', () => {
    const items = compareBalance(ours, { currency: 'USD', balance: '', equity: '10125.50' });
    expect(statuses(items)).toEqual([ItemStatus.UNKNOWN]);
    expect(needsAttention(items)).toBe(true);
  });

  it('treats a value that is not a number as uncomparable, not as zero', () => {
    const item = only(
      compareBalance(ours, { currency: 'USD', balance: 'n/a', equity: '10125.50' }),
    );
    expect(item.status).toBe(ItemStatus.UNKNOWN);
    expect(item.difference).toBeNull();
  });
});

describe('orders against the venue', () => {
  const ours = (over: Partial<InternalOrder> = {}): InternalOrder => ({
    clientOrderId: 'c-1',
    volume: '1.00',
    filledVolume: '1.00',
    price: null,
    status: 'FILLED',
    ...over,
  });
  const theirs = (over: Partial<ExternalOrder> = {}): ExternalOrder => ({
    clientOrderId: 'c-1',
    externalOrderId: 'x-1',
    volume: '1.00',
    filledVolume: '1.00',
    price: null,
    status: 'FILLED',
    ...over,
  });

  it('matches an order both sides agree on', () => {
    expect(statuses(compareOrders([ours()], [theirs()]))).toEqual([ItemStatus.MATCHED]);
  });

  /** A position we believe in and nobody is holding. */
  it('reports an order the venue does not have', () => {
    const item = only(compareOrders([ours()], []));
    expect(item.status).toBe(ItemStatus.MISSING_EXTERNAL);
    expect(item.key).toBe('c-1');
  });

  /** A trade nobody here booked. */
  it('reports an order the venue has and we do not', () => {
    const item = only(compareOrders([], [theirs()]));
    expect(item.status).toBe(ItemStatus.MISSING_INTERNAL);
    expect(item.external).toBe('x-1');
  });

  /**
   * A venue order with no client order id is one this platform never sent. It
   * is reported, not dropped — dropping it is how a trade placed outside the
   * platform stays invisible.
   */
  it('reports a venue order that carries no client order id', () => {
    const item = only(compareOrders([], [theirs({ clientOrderId: null })]));
    expect(item.status).toBe(ItemStatus.MISSING_INTERNAL);
    expect(item.key).toBe('x-1');
    expect(item.message).toMatch(/never sent/);
  });

  it('reports volume and fill as separate findings', () => {
    const items = compareOrders(
      [ours({ volume: '2.00', filledVolume: '2.00' })],
      [theirs({ volume: '1.00', filledVolume: '0.50' })],
    );
    expect(items.map((item) => item.field)).toEqual(['volume', 'filledVolume']);
    expect(statuses(items)).toEqual([ItemStatus.QUANTITY_MISMATCH, ItemStatus.QUANTITY_MISMATCH]);
  });

  it('reports a price that disagrees as a price mismatch', () => {
    const item = only(compareOrders([ours({ price: '4600.00' })], [theirs({ price: '4600.10' })]));
    expect(item.status).toBe(ItemStatus.PRICE_MISMATCH);
    expect(item.difference).toBe('-0.1');
  });

  /**
   * A market order has no price on either side. An UNKNOWN for every one of
   * them would bury the report in noise about the thing that works.
   */
  it('says nothing about a price neither side has', () => {
    expect(statuses(compareOrders([ours({ price: null })], [theirs({ price: null })]))).toEqual([
      ItemStatus.MATCHED,
    ]);
  });
});

describe('positions against the venue', () => {
  const ours: InternalPosition = {
    externalPositionId: 'p-1',
    volume: '1.00',
    entryPrice: '4583.58',
  };
  const theirs: ExternalPosition = {
    externalPositionId: 'p-1',
    volume: '1.00',
    entryPrice: '4583.58',
  };

  it('matches a position both sides agree on', () => {
    expect(statuses(comparePositions([ours], [theirs]))).toEqual([ItemStatus.MATCHED]);
  });

  it('reports a position the venue does not hold', () => {
    expect(statuses(comparePositions([ours], []))).toEqual([ItemStatus.MISSING_EXTERNAL]);
  });

  it('reports a position the venue holds and we do not', () => {
    expect(statuses(comparePositions([], [theirs]))).toEqual([ItemStatus.MISSING_INTERNAL]);
  });

  it('reports a volume that is one hundredth of a lot out', () => {
    const item = only(comparePositions([ours], [{ ...theirs, volume: '0.99' }]));
    expect(item.status).toBe(ItemStatus.QUANTITY_MISMATCH);
    expect(item.difference).toBe('0.01');
  });
});

describe('executions against the venue', () => {
  const ours: InternalExecution = {
    externalExecutionId: 'e-1',
    volume: '1.00',
    price: '4583.58',
    commission: '7.00',
  };
  const theirs: ExternalExecution = {
    externalExecutionId: 'e-1',
    volume: '1.00',
    price: '4583.58',
    commission: '7.00',
  };

  it('matches a fill both sides agree on', () => {
    expect(statuses(compareExecutions([ours], [theirs]))).toEqual([ItemStatus.MATCHED]);
  });

  it('reports a commission that is a cent out as a fee mismatch', () => {
    const item = only(compareExecutions([ours], [{ ...theirs, commission: '7.01' }]));
    expect(item.status).toBe(ItemStatus.FEE_MISMATCH);
    expect(item.difference).toBe('-0.01');
  });

  /**
   * A venue that does not report commission is not a venue that charges zero.
   * Recording the full amount as a mismatch would be a finding about our own
   * assumption rather than about the money.
   */
  it('says nothing about a commission the venue does not quote', () => {
    expect(statuses(compareExecutions([ours], [{ ...theirs, commission: null }]))).toEqual([
      ItemStatus.MATCHED,
    ]);
  });

  it('reports a fill the venue never made', () => {
    expect(statuses(compareExecutions([ours], []))).toEqual([ItemStatus.MISSING_EXTERNAL]);
  });

  it('reports a fill this platform never booked', () => {
    expect(statuses(compareExecutions([], [theirs]))).toEqual([ItemStatus.MISSING_INTERNAL]);
  });
});

describe('the run summary', () => {
  it('counts every status, including the ones that are zero', () => {
    const counts = tally(compareOrders([], []));
    expect(counts.MATCHED).toBe(0);
    expect(counts.UNKNOWN).toBe(0);
    expect(Object.keys(counts).sort()).toEqual(Object.values(ItemStatus).sort());
  });

  it('is quiet only when everything matched', () => {
    expect(needsAttention([])).toBe(false);
    expect(
      needsAttention(
        compareBalance(
          { accountNumber: 'TP-1', currency: 'USD', balance: '1', equity: '1' },
          { currency: 'USD', balance: '1', equity: '1' },
        ),
      ),
    ).toBe(false);
  });
});

describe('commission over a window', () => {
  /**
   * Per fill is impossible and per window is honest: this platform books
   * commission against the position and the venue against the fill, and any
   * per-fill number derived from ours would be a finding about the derivation.
   */
  it('matches when the totals agree', () => {
    expect(statuses(compareFeeTotals('TP-1', '21.00', '21.00'))).toEqual([ItemStatus.MATCHED]);
  });

  it('reports a total that is a cent out', () => {
    const item = only(compareFeeTotals('TP-1', '21.00', '21.01'));
    expect(item.status).toBe(ItemStatus.FEE_MISMATCH);
    expect(item.field).toBe('commissionTotal');
    expect(item.difference).toBe('-0.01');
  });

  /**
   * A venue that reports no commission is not a venue that charges nothing.
   * Comparing against an assumed zero would raise the full amount as a
   * mismatch, every run, against every such venue.
   */
  /**
   * Nothing charged here, nothing said there. An absence, not a discrepancy —
   * and an UNKNOWN on every quiet account on every run makes a report whose
   * normal state is a page of them, which nobody reads closely enough to spot
   * the real one.
   */
  it('says nothing when neither side charged anything', () => {
    expect(compareFeeTotals('TP-1', '0', null)).toEqual([]);
  });

  it('does not read silence as zero', () => {
    const item = only(compareFeeTotals('TP-1', '21.00', null));
    expect(item.status).toBe(ItemStatus.UNKNOWN);
    expect(item.difference).toBeNull();
  });
});
