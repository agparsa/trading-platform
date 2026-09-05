import type { BrokerAdapter } from './adapter';
import {
  BrokerAdapterError,
  BrokerErrorCode,
  ConnectionState,
  type BrokerCredentials,
  type NormalisedOrder,
} from './types';

/**
 * What a test harness gives the contract: a fresh adapter, credentials that
 * work and credentials that do not, an account and an instrument the venue
 * has, and — when the venue can be scripted — a way to make the next order
 * time out with the venue having filled it.
 */
export interface ContractHarness {
  create(): BrokerAdapter;
  readonly validCredentials: BrokerCredentials;
  readonly invalidCredentials: BrokerCredentials;
  readonly externalAccountId: string;
  readonly externalSymbol: string;
  /** Make the next `placeOrder` answer UNKNOWN while the venue fills it. Optional. */
  scriptTimeoutFilled?(adapter: BrokerAdapter): void;
  /** Make the next `placeOrder` be rejected by the venue. Optional. */
  scriptRejection?(adapter: BrokerAdapter): void;
}

/**
 * The contract every connector must pass, as a function a test file calls
 * inside its own `describe`. It takes the test primitives as arguments so the
 * SDK does not depend on a test runner.
 *
 * The contract is about the **promises the platform relies on**, not about
 * the venue's business rules: capabilities are honest, errors are typed,
 * UNKNOWN is recoverable, ids are stable, secrets never surface. A connector
 * that fails one of these is one the platform cannot run safely, however
 * well it trades.
 */
export function brokerAdapterContract(
  harness: ContractHarness,
  t: {
    it: (name: string, fn: () => Promise<void>) => void;
    expect: ExpectLike;
  },
): void {
  const { it, expect } = t;
  const order = (clientOrderId: string): NormalisedOrder => ({
    clientOrderId,
    externalAccountId: harness.externalAccountId,
    externalSymbol: harness.externalSymbol,
    side: 'BUY',
    type: 'MARKET',
    volume: '0.10',
    price: null,
    stopPrice: null,
    stopLoss: null,
    takeProfit: null,
    timeInForce: 'IOC',
  });
  const fresh = async (): Promise<BrokerAdapter> => {
    const adapter = harness.create();
    await adapter.connect(harness.validCredentials);
    return adapter;
  };

  it('refuses bad credentials with AUTH_FAILED and reports it in its health', async () => {
    const adapter = harness.create();
    let thrown: unknown = null;
    try {
      await adapter.connect(harness.invalidCredentials);
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof BrokerAdapterError).toBe(true);
    expect((thrown as BrokerAdapterError).code).toBe(BrokerErrorCode.AUTH_FAILED);
    const health = await adapter.healthcheck();
    expect(health.state).toBe(ConnectionState.AUTH_FAILED);
  });

  it('is NOT_CONNECTED before connect, and healthy after', async () => {
    const adapter = harness.create();
    let code: string | null = null;
    try {
      await adapter.listInstruments();
    } catch (error) {
      code = error instanceof BrokerAdapterError ? error.code : 'not a BrokerAdapterError';
    }
    expect(code).toBe(BrokerErrorCode.NOT_CONNECTED);
    await adapter.connect(harness.validCredentials);
    const health = await adapter.healthcheck();
    expect(health.state).toBe(ConnectionState.CONNECTED);
    expect(typeof health.latencyMs === 'number' || health.latencyMs === null).toBe(true);
  });

  it('never surfaces a credential value in an error message', async () => {
    const adapter = harness.create();
    const secrets = Object.values(harness.invalidCredentials.fields).filter((v) => v.length >= 4);
    let message = '';
    try {
      await adapter.connect(harness.invalidCredentials);
    } catch (error) {
      message =
        error instanceof Error ? `${error.message} ${String(error.stack ?? '')}` : String(error);
    }
    for (const secret of secrets) expect(message.includes(secret)).toBe(false);
  });

  it('declares capabilities and lists the instrument the harness names', async () => {
    const adapter = await fresh();
    const capabilities = await adapter.getCapabilities();
    expect(typeof capabilities.supportsMarketOrders).toBe('boolean');
    expect(Array.isArray(capabilities.timeInForce)).toBe(true);
    const instruments = await adapter.listInstruments();
    expect(instruments.some((row) => row.externalSymbol === harness.externalSymbol)).toBe(true);
    for (const row of instruments) {
      expect(typeof row.contractSize).toBe('string');
      expect(typeof row.volumeStep).toBe('string');
    }
  });

  it('refuses an order type it says it does not support with UNSUPPORTED, before sending', async () => {
    const adapter = await fresh();
    const capabilities = await adapter.getCapabilities();
    const unsupported = (
      [
        ['MARKET', capabilities.supportsMarketOrders],
        ['LIMIT', capabilities.supportsLimitOrders],
        ['STOP', capabilities.supportsStopOrders],
        ['STOP_LIMIT', capabilities.supportsStopLimitOrders],
      ] as const
    ).find(([, supported]) => !supported);
    if (unsupported === undefined) return; // supports everything; nothing to refuse
    let code: string | null = null;
    try {
      await adapter.placeOrder({
        ...order(`contract-unsupported-${Date.now()}`),
        type: unsupported[0],
        price: unsupported[0] === 'MARKET' ? null : '1',
        stopPrice: unsupported[0].startsWith('STOP') ? '1' : null,
      });
    } catch (error) {
      code = error instanceof BrokerAdapterError ? error.code : 'not a BrokerAdapterError';
    }
    expect(code).toBe(BrokerErrorCode.UNSUPPORTED);
  });

  it('reports account figures as strings, never floats', async () => {
    const adapter = await fresh();
    const capabilities = await adapter.getCapabilities();
    if (!capabilities.supportsAccountSync) return;
    const snapshot = await adapter.getAccount(harness.externalAccountId);
    for (const value of [
      snapshot.balance,
      snapshot.equity,
      snapshot.usedMargin,
      snapshot.freeMargin,
    ]) {
      expect(typeof value).toBe('string');
      expect(/^-?\d+(\.\d+)?$/.test(value)).toBe(true);
    }
  });

  it('fills a market order with string prices, a position id and an execution id', async () => {
    const adapter = await fresh();
    const result = await adapter.placeOrder(order(`contract-fill-${Date.now()}`));
    expect(['FILLED', 'PARTIALLY_FILLED', 'ACCEPTED', 'UNKNOWN', 'REJECTED']).toContain(
      result.outcome,
    );
    if (result.outcome === 'FILLED') {
      expect(result.fills.length > 0).toBe(true);
      expect(typeof result.fills[0]?.price).toBe('string');
      expect(typeof result.fills[0]?.externalExecutionId).toBe('string');
      expect(
        result.externalPositionId === null || typeof result.externalPositionId === 'string',
      ).toBe(true);
    }
  });

  it('is idempotent on the client order id', async () => {
    const adapter = await fresh();
    const id = `contract-idem-${Date.now()}`;
    const first = await adapter.placeOrder(order(id));
    const second = await adapter.placeOrder(order(id));
    expect(second.outcome).toBe(first.outcome);
    expect(second.externalOrderId).toBe(first.externalOrderId);
    const positions = await adapter.getPositions(harness.externalAccountId);
    expect(
      positions.filter((p) => p.externalPositionId === first.externalPositionId).length <= 1,
    ).toBe(true);
  });

  it('answers the recovery query with null for an id the venue never saw', async () => {
    const adapter = await fresh();
    expect(await adapter.queryOrder(`contract-never-${Date.now()}`)).toBe(null);
  });

  if (harness.scriptTimeoutFilled !== undefined) {
    it('recovers an UNKNOWN outcome through the query rather than a resend', async () => {
      const adapter = await fresh();
      harness.scriptTimeoutFilled?.(adapter);
      const id = `contract-unknown-${Date.now()}`;
      const result = await adapter.placeOrder(order(id));
      expect(result.outcome).toBe('UNKNOWN');
      const found = await adapter.queryOrder(id);
      expect(found?.outcome).toBe('FILLED');
      expect(found?.clientOrderId).toBe(id);
    });
  }

  if (harness.scriptRejection !== undefined) {
    it('reports a venue rejection as an outcome with the reason, not as an exception', async () => {
      const adapter = await fresh();
      harness.scriptRejection?.(adapter);
      const result = await adapter.placeOrder(order(`contract-reject-${Date.now()}`));
      expect(result.outcome).toBe('REJECTED');
      expect(typeof result.reason).toBe('string');
    });
  }

  it('closes a position it opened and the position is gone', async () => {
    const adapter = await fresh();
    const opened = await adapter.placeOrder(order(`contract-close-${Date.now()}`));
    if (opened.outcome !== 'FILLED' || opened.externalPositionId === null) return;
    const closed = await adapter.closePosition(opened.externalPositionId, null);
    expect(closed.outcome).toBe('FILLED');
    const positions = await adapter.getPositions(harness.externalAccountId);
    expect(positions.some((p) => p.externalPositionId === opened.externalPositionId)).toBe(false);
  });

  it('pushes events with stable ids and a sequence, when it says it does', async () => {
    const adapter = await fresh();
    const capabilities = await adapter.getCapabilities();
    if (!capabilities.supportsOrderEvents) return;
    const seen: { id: string; sequence: number | null }[] = [];
    const off = adapter.onEvent((event) => {
      seen.push({ id: event.externalEventId, sequence: event.sequence });
    });
    await adapter.placeOrder(order(`contract-events-${Date.now()}`));
    off();
    expect(seen.length > 0).toBe(true);
    for (const event of seen)
      expect(typeof event.id === 'string' && event.id.length > 0).toBe(true);
    expect(new Set(seen.map((e) => e.id)).size).toBe(seen.length);
  });

  it('subscribes to quotes and delivers strings, when it says it streams', async () => {
    const adapter = await fresh();
    const capabilities = await adapter.getCapabilities();
    if (!capabilities.supportsStreamingQuotes) return;
    const quotes: { bid: string; ask: string }[] = [];
    const unsubscribe = await adapter.subscribeQuotes([harness.externalSymbol], (quote) => {
      quotes.push({ bid: quote.bid, ask: quote.ask });
    });
    await unsubscribe();
    expect(quotes.length > 0).toBe(true);
    expect(typeof quotes[0]?.bid).toBe('string');
  });
}

/** The subset of an expect API the contract uses. Vitest's satisfies it. */
export interface ExpectLike {
  (actual: unknown): {
    toBe(expected: unknown): void;
    toContain(expected: unknown): void;
  };
}
