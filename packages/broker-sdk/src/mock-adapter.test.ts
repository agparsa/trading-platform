import { describe, expect, it } from 'vitest';
import { brokerAdapterContract } from './contract';
import { MockBrokerAdapter, mockBrokerAdapterFactory } from './mock-adapter';
import { BrokerAdapterRegistry } from './registry';
import {
  credentialMetadata,
  deserialiseCredentials,
  fingerprintCredentials,
  redactCredentialValues,
  serialiseCredentials,
} from './credentials';
import type { BrokerAdapterError, BrokerEvent, NormalisedOrder } from './types';

const CREDENTIALS = {
  kind: 'LOGIN_PASSWORD_SERVER' as const,
  fields: { login: '1001', password: 'correct-horse', server: 'Mock-Live' },
};
const WRONG = { ...CREDENTIALS, fields: { ...CREDENTIALS.fields, password: 'wrong' } };
const ACCOUNT = 'MOCK-1001';
const SYMBOL = 'XAUUSD.m';

const order = (
  clientOrderId: string,
  overrides: Partial<NormalisedOrder> = {},
): NormalisedOrder => ({
  clientOrderId,
  externalAccountId: ACCOUNT,
  externalSymbol: SYMBOL,
  side: 'BUY',
  type: 'MARKET',
  volume: '1.00',
  price: null,
  stopPrice: null,
  stopLoss: null,
  takeProfit: null,
  timeInForce: 'IOC',
  ...overrides,
});

async function connected(latencyMs = 0): Promise<MockBrokerAdapter> {
  const adapter = new MockBrokerAdapter({ latencyMs });
  await adapter.connect(CREDENTIALS);
  return adapter;
}

/**
 * The mock passes the contract every connector must pass. A real connector's
 * test file is this block with a different harness.
 */
describe('MockBrokerAdapter satisfies the adapter contract', () => {
  brokerAdapterContract(
    {
      create: () => new MockBrokerAdapter({ latencyMs: 0 }),
      validCredentials: CREDENTIALS,
      invalidCredentials: WRONG,
      externalAccountId: ACCOUNT,
      externalSymbol: SYMBOL,
      scriptTimeoutFilled: (adapter) =>
        (adapter as MockBrokerAdapter).script({ kind: 'timeout-filled' }),
      scriptRejection: (adapter) =>
        (adapter as MockBrokerAdapter).script({ kind: 'reject', reason: 'not enough margin' }),
    },
    { it, expect },
  );
});

describe('the failure catalogue', () => {
  it('fills, partially fills, accepts and rejects as scripted, in order', async () => {
    const adapter = await connected();
    adapter.script(
      { kind: 'fill', price: '4590.00' },
      { kind: 'partial', volume: '0.40' },
      { kind: 'accept' },
      { kind: 'reject', reason: 'market closed' },
    );
    const a = await adapter.placeOrder(order('a'));
    expect(a).toMatchObject({ outcome: 'FILLED', fills: [{ volume: '1.00', price: '4590.00' }] });
    const b = await adapter.placeOrder(order('b'));
    expect(b).toMatchObject({ outcome: 'PARTIALLY_FILLED', fills: [{ volume: '0.40' }] });
    const c = await adapter.placeOrder(order('c', { type: 'LIMIT', price: '4500.00' }));
    expect(c.outcome).toBe('ACCEPTED');
    expect((await adapter.getOrders(ACCOUNT)).find((o) => o.clientOrderId === 'c')?.status).toBe(
      'WORKING',
    );
    const d = await adapter.placeOrder(order('d'));
    expect(d).toMatchObject({ outcome: 'REJECTED', reason: 'market closed' });
    expect((await adapter.getPositions(ACCOUNT)).map((p) => p.volume).sort()).toEqual([
      '0.40',
      '1.00',
    ]);
  });

  it('a lost timeout is UNKNOWN and the query says the venue never saw it', async () => {
    const adapter = await connected();
    adapter.script({ kind: 'timeout-lost' });
    const result = await adapter.placeOrder(order('lost'));
    expect(result.outcome).toBe('UNKNOWN');
    expect(await adapter.queryOrder('lost')).toBe(null);
    expect(await adapter.getPositions(ACCOUNT)).toHaveLength(0);
  });

  it('a filled timeout is UNKNOWN, the position exists, and resending is refused by idempotency', async () => {
    const adapter = await connected();
    adapter.script({ kind: 'timeout-filled' });
    const first = await adapter.placeOrder(order('filled'));
    expect(first.outcome).toBe('UNKNOWN');
    expect(await adapter.getPositions(ACCOUNT)).toHaveLength(1);
    // A blind resend with the same client id does not open a second position.
    const again = await adapter.placeOrder(order('filled'));
    expect(again.outcome).toBe('FILLED');
    expect(await adapter.getPositions(ACCOUNT)).toHaveLength(1);
  });

  it('a disconnect mid-order throws NOT_CONNECTED, emits CONNECTION_LOST, and reconnecting restores', async () => {
    const adapter = await connected();
    const events: BrokerEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    adapter.script({ kind: 'disconnect' });
    await expect(adapter.placeOrder(order('x'))).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    expect((await adapter.healthcheck()).state).toBe('DISCONNECTED');
    expect(events.map((e) => e.kind)).toEqual(['CONNECTION_LOST']);
    await adapter.connect(CREDENTIALS);
    expect(events.map((e) => e.kind)).toEqual(['CONNECTION_LOST', 'CONNECTION_RESTORED']);
    expect((await adapter.placeOrder(order('y'))).outcome).toBe('FILLED');
  });

  it('rate limit, auth failure and venue error are typed, with retryability the platform can weigh', async () => {
    const adapter = await connected();
    adapter.script(
      { kind: 'rate-limit' },
      { kind: 'venue-error', message: 'boom' },
      { kind: 'auth-failed' },
    );
    const limited = await adapter
      .placeOrder(order('r'))
      .catch((e: unknown) => e as BrokerAdapterError);
    expect(limited).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    const venue = await adapter
      .placeOrder(order('v'))
      .catch((e: unknown) => e as BrokerAdapterError);
    expect(venue).toMatchObject({ code: 'VENUE_ERROR', retryable: true, message: 'boom' });
    const auth = await adapter
      .placeOrder(order('a'))
      .catch((e: unknown) => e as BrokerAdapterError);
    expect(auth).toMatchObject({ code: 'AUTH_FAILED', retryable: false });
    expect((await adapter.healthcheck()).state).toBe('AUTH_FAILED');
  });

  it('redelivers an event with the same id and can deliver out of order', async () => {
    const adapter = await connected();
    const seen: BrokerEvent[] = [];
    adapter.onEvent((event) => seen.push(event));
    await adapter.placeOrder(order('one'));
    const [filled, opened] = seen;
    expect(filled?.kind).toBe('ORDER_FILLED');
    expect(opened?.kind).toBe('POSITION_OPENED');
    adapter.redeliver(filled!.externalEventId);
    expect(seen[2]).toEqual(filled);
    adapter.emitOutOfOrder([filled!, opened!]);
    expect(seen.slice(3).map((e) => e.sequence)).toEqual([opened!.sequence, filled!.sequence]);
  });

  it('closes partially with exact decimal arithmetic and emits the close', async () => {
    const adapter = await connected();
    const opened = await adapter.placeOrder(order('p', { volume: '0.30' }));
    const seen: BrokerEvent[] = [];
    adapter.onEvent((event) => seen.push(event));
    const closed = await adapter.closePosition(opened.externalPositionId!, '0.10');
    expect(closed.outcome).toBe('FILLED');
    expect(closed.fills[0]?.price).toBe('4583.58'); // a BUY closes at the bid
    const remaining = (await adapter.getPositions(ACCOUNT))[0];
    expect(remaining?.volume).toBe('0.2');
    expect(seen[0]).toMatchObject({
      kind: 'POSITION_CLOSED',
      payload: { volume: '0.10', remaining: '0.2' },
    });
    const executions = await adapter.getExecutions(ACCOUNT, new Date(0));
    expect(executions).toHaveLength(2);
  });

  it('refuses a partial close when the venue says it cannot', async () => {
    const adapter = new MockBrokerAdapter({
      latencyMs: 0,
      capabilities: { supportsPartialClose: false },
    });
    await adapter.connect(CREDENTIALS);
    const opened = await adapter.placeOrder(order('w', { volume: '0.30' }));
    await expect(adapter.closePosition(opened.externalPositionId!, '0.10')).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    expect((await adapter.closePosition(opened.externalPositionId!, null)).outcome).toBe('FILLED');
  });

  it('streams a quote when the price moves, to subscribers of that symbol only', async () => {
    const adapter = await connected();
    const gold: string[] = [];
    const euro: string[] = [];
    await adapter.subscribeQuotes(['XAUUSD.m'], (q) => gold.push(q.bid));
    const off = await adapter.subscribeQuotes(['EURUSD.m'], (q) => euro.push(q.bid));
    adapter.setPrice('XAUUSD.m', '4600.00', '4600.20');
    adapter.setPrice('EURUSD.m', '1.09000', '1.09010');
    await off();
    adapter.setPrice('EURUSD.m', '1.10000', '1.10010');
    expect(gold).toEqual(['4583.58', '4600.00']);
    expect(euro).toEqual(['1.08412', '1.09000']);
  });
});

describe('credentials', () => {
  it('round-trips through the sealed payload and fingerprints without revealing anything', () => {
    const plaintext = serialiseCredentials(CREDENTIALS);
    expect(deserialiseCredentials(plaintext)).toEqual(CREDENTIALS);
    const fingerprint = fingerprintCredentials(CREDENTIALS);
    expect(fingerprint).toHaveLength(16);
    expect(fingerprint).not.toBe(fingerprintCredentials(WRONG));
    const metadata = credentialMetadata(CREDENTIALS, new Set(['password']));
    expect(metadata).toEqual({
      kind: 'LOGIN_PASSWORD_SERVER',
      fingerprint,
      visible: { login: '1001', server: 'Mock-Live' },
    });
    expect(JSON.stringify(metadata)).not.toContain('correct-horse');
    expect(redactCredentialValues('login correct-horse failed on Mock-Live', CREDENTIALS)).toBe(
      'login [redacted] failed on [redacted]',
    );
  });

  it('refuses a payload it does not understand', () => {
    expect(() => deserialiseCredentials('{"version":2}')).toThrow(/not in a form/);
  });
});

describe('the registry', () => {
  it('holds the mock and refuses a venue connector that names no documentation', () => {
    const registry = new BrokerAdapterRegistry();
    expect(registry.kinds().map((f) => f.kind)).toEqual(['MOCK']);
    expect(registry.has('MOCK')).toBe(true);
    expect(registry.create('MOCK').kind).toBe('MOCK');
    expect(() => registry.create('ACME')).toThrow(/no connector of kind ACME/);
    expect(() =>
      registry.register({ ...mockBrokerAdapterFactory, kind: 'ACME', documentation: '   ' }),
    ).toThrow(/names no documentation/);
    registry.register({
      ...mockBrokerAdapterFactory,
      kind: 'ACME',
      documentation: 'https://docs.acme.example/v3 (read 2026-09-03)',
    });
    expect(registry.has('ACME')).toBe(true);
  });
});
