import { describe, expect, it } from 'vitest';
import {
  beginCommand,
  COMMAND_LOG_LIMIT,
  CommandState,
  noteOrderClosed,
  noteOrderFilled,
  settleCommand,
  settlementFromResponse,
  type NewCommand,
  type OrderCommand,
} from './order-commands';

const submission = (overrides: Partial<NewCommand> = {}): NewCommand => ({
  commandId: 'cmd-1',
  symbol: 'XAUUSD',
  side: 'BUY',
  type: 'MARKET',
  volume: '0.10',
  at: 1_000,
  ...overrides,
});

describe('beginCommand', () => {
  it('records a submission as in flight, newest first', () => {
    const log = beginCommand(beginCommand([], submission()), submission({ commandId: 'cmd-2' }));
    expect(log.map((row) => row.commandId)).toEqual(['cmd-2', 'cmd-1']);
    expect(log[0]?.state).toBe(CommandState.SUBMITTING);
    expect(log[0]?.settledAt).toBeNull();
  });

  it('keeps the log bounded', () => {
    let log: OrderCommand[] = [];
    for (let i = 0; i < COMMAND_LOG_LIMIT + 5; i += 1) {
      log = beginCommand(log, submission({ commandId: `cmd-${i}` }));
    }
    expect(log).toHaveLength(COMMAND_LOG_LIMIT);
    expect(log[0]?.commandId).toBe(`cmd-${COMMAND_LOG_LIMIT + 4}`);
  });

  it('does not list one command twice if it is somehow re-begun', () => {
    const log = beginCommand(beginCommand([], submission()), submission());
    expect(log).toHaveLength(1);
  });
});

describe('settlementFromResponse', () => {
  /**
   * The distinction the whole module exists for. A resting order that has been
   * accepted has not filled, and telling a trader it has is a lie they act on.
   */
  it('calls a filled market order executed', () => {
    const settled = settlementFromResponse(
      'MARKET',
      { orderId: 'o1', positionId: 'p1', price: '4583.72' },
      2_000,
    );
    expect(settled.state).toBe(CommandState.EXECUTED);
    expect(settled.positionId).toBe('p1');
    expect(settled.price).toBe('4583.72');
  });

  it('calls an accepted resting order accepted, not executed', () => {
    const settled = settlementFromResponse('LIMIT', { orderId: 'o1', price: '4570.00' }, 2_000);
    expect(settled.state).toBe(CommandState.ACCEPTED);
    expect(settled.positionId).toBeNull();
  });

  it('will not claim a fill a market response did not report', () => {
    const settled = settlementFromResponse('MARKET', { orderId: 'o1' }, 2_000);
    expect(settled.state).toBe(CommandState.ACCEPTED);
  });

  it('survives a response that is not an object', () => {
    expect(settlementFromResponse('MARKET', null, 2_000).state).toBe(CommandState.ACCEPTED);
    expect(settlementFromResponse('MARKET', 'nonsense', 2_000).orderId).toBeNull();
  });
});

describe('settleCommand', () => {
  it('applies an outcome to the command it names and no other', () => {
    let log = beginCommand([], submission());
    log = beginCommand(log, submission({ commandId: 'cmd-2' }));
    log = settleCommand(log, 'cmd-1', {
      state: CommandState.REJECTED,
      reason: 'Insufficient margin',
      at: 3_000,
    });

    expect(log.find((row) => row.commandId === 'cmd-1')?.state).toBe(CommandState.REJECTED);
    expect(log.find((row) => row.commandId === 'cmd-1')?.reason).toBe('Insufficient margin');
    expect(log.find((row) => row.commandId === 'cmd-2')?.state).toBe(CommandState.SUBMITTING);
  });

  /**
   * A settlement whose submission has already been trimmed away must not
   * conjure a row: a trader would see an order that has an ending and no
   * beginning.
   */
  it('ignores an outcome for a command it does not hold', () => {
    const log = settleCommand([], 'cmd-9', { state: CommandState.EXECUTED, at: 3_000 });
    expect(log).toEqual([]);
  });

  it('clears a stale rejection reason when a command settles again', () => {
    let log = beginCommand([], submission());
    log = settleCommand(log, 'cmd-1', {
      state: CommandState.REJECTED,
      reason: 'refused',
      at: 2_000,
    });
    log = settleCommand(log, 'cmd-1', { state: CommandState.ACCEPTED, at: 3_000 });
    expect(log[0]?.reason).toBeNull();
  });
});

describe('noteOrderFilled', () => {
  const accepted = () => {
    const log = beginCommand([], submission({ type: 'LIMIT' }));
    return settleCommand(log, 'cmd-1', {
      state: CommandState.ACCEPTED,
      orderId: 'o1',
      at: 2_000,
    });
  };

  it('advances a resting order when its fill arrives over the socket', () => {
    const log = noteOrderFilled(accepted(), 'o1', 'p1', 5_000);
    expect(log[0]?.state).toBe(CommandState.EXECUTED);
    expect(log[0]?.positionId).toBe('p1');
    expect(log[0]?.settledAt).toBe(5_000);
  });

  it('leaves another order alone', () => {
    const log = noteOrderFilled(accepted(), 'o2', 'p1', 5_000);
    expect(log[0]?.state).toBe(CommandState.ACCEPTED);
  });

  /** A refused order cannot later fill; treating a fill as authority over that would be wrong. */
  it('does not resurrect a rejected command', () => {
    let log = beginCommand([], submission({ type: 'LIMIT' }));
    log = settleCommand(log, 'cmd-1', {
      state: CommandState.REJECTED,
      orderId: 'o1',
      reason: 'no',
      at: 2_000,
    });
    expect(noteOrderFilled(log, 'o1', 'p1', 5_000)[0]?.state).toBe(CommandState.REJECTED);
  });

  it('does not move the settlement time of a command already executed', () => {
    let log = beginCommand([], submission());
    log = settleCommand(log, 'cmd-1', {
      state: CommandState.EXECUTED,
      orderId: 'o1',
      at: 2_000,
    });
    expect(noteOrderFilled(log, 'o1', 'p1', 5_000)[0]?.settledAt).toBe(2_000);
  });
});

describe('noteOrderClosed', () => {
  it('marks a cancelled resting order as no longer coming', () => {
    let log = beginCommand([], submission({ type: 'STOP' }));
    log = settleCommand(log, 'cmd-1', {
      state: CommandState.ACCEPTED,
      orderId: 'o1',
      at: 2_000,
    });
    const closed = noteOrderClosed(log, 'o1', 'cancelled', 6_000);
    expect(closed[0]?.state).toBe(CommandState.REJECTED);
    expect(closed[0]?.reason).toBe('cancelled');
  });

  it('does not undo a fill that already happened', () => {
    let log = beginCommand([], submission());
    log = settleCommand(log, 'cmd-1', {
      state: CommandState.EXECUTED,
      orderId: 'o1',
      at: 2_000,
    });
    expect(noteOrderClosed(log, 'o1', 'cancelled', 6_000)[0]?.state).toBe(CommandState.EXECUTED);
  });
});
