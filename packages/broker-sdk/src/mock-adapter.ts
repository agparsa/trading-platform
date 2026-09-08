import { randomUUID } from 'node:crypto';
import type { BrokerAdapter, BrokerAdapterFactory } from './adapter';
import {
  BrokerAdapterError,
  BrokerErrorCode,
  BrokerEventKind,
  ConnectionState,
  type AdapterHealth,
  type BrokerAccountSnapshot,
  type BrokerCapabilities,
  type BrokerCredentials,
  type BrokerEvent,
  type BrokerFill,
  type BrokerInstrument,
  type BrokerOrder,
  type BrokerPosition,
  type BrokerQuote,
  type NormalisedOrder,
  type OrderResult,
} from './types';

/**
 * A venue that does exactly what it is told to, so the platform's handling of
 * every outcome can be exercised without one.
 *
 * ## Scripted behaviours
 *
 * `script(...)` queues what the next `placeOrder` calls do, in order. When
 * the queue is empty the mock fills at the scripted or default price. The
 * catalogue is the specification's §41 and §67: fills, partial fills,
 * rejections, a timeout (UNKNOWN — the order *did* reach the venue), a
 * timeout where it did not, a disconnect, a rate limit, an auth failure,
 * duplicate events, out-of-order events. A test names the behaviour it is
 * about; nothing here is random.
 *
 * ## It keeps real state
 *
 * Positions opened here can be closed, modified, listed and reconciled, and
 * every change emits an event with a stable id and a sequence number, so the
 * inbox and the reconciliation can be tested against something that behaves
 * like a venue rather than against a stub that returns what it was asked to.
 *
 * The password `wrong` fails authentication; any other set of fields
 * succeeds. Nothing is logged.
 */
export type MockBehaviour =
  | { readonly kind: 'fill'; readonly price?: string }
  | { readonly kind: 'partial'; readonly volume: string; readonly price?: string }
  | { readonly kind: 'reject'; readonly reason: string }
  | { readonly kind: 'accept' }
  /** The request reached the venue and was filled, but the answer is lost. */
  | { readonly kind: 'timeout-filled'; readonly price?: string }
  /** The request never reached the venue. */
  | { readonly kind: 'timeout-lost' }
  | { readonly kind: 'disconnect' }
  | { readonly kind: 'rate-limit'; readonly retryAfterMs?: number }
  | { readonly kind: 'auth-failed' }
  | { readonly kind: 'venue-error'; readonly message: string };

export interface MockOptions {
  readonly capabilities?: Partial<BrokerCapabilities>;
  readonly instruments?: readonly BrokerInstrument[];
  readonly prices?: Readonly<Record<string, { bid: string; ask: string }>>;
  readonly accounts?: readonly { id: string; currency: string; balance: string }[];
  readonly latencyMs?: number;
  readonly clock?: () => Date;
}

const DEFAULT_CAPABILITIES: BrokerCapabilities = {
  supportsMarketOrders: true,
  supportsLimitOrders: true,
  supportsStopOrders: true,
  supportsStopLimitOrders: false,
  supportsPartialClose: true,
  supportsModifyProtection: true,
  supportsHedging: true,
  supportsStreamingQuotes: true,
  supportsOrderEvents: true,
  supportsAccountSync: true,
  supportsHistoricalCandles: false,
  supportsApiToken: true,
  supportsWebhooks: false,
  timeInForce: ['GTC', 'IOC', 'FOK'],
};

const DEFAULT_INSTRUMENTS: readonly BrokerInstrument[] = [
  {
    externalSymbol: 'XAUUSD.m',
    description: 'Gold vs US Dollar',
    quoteCurrency: 'USD',
    contractSize: '100',
    volumeStep: '0.01',
    minVolume: '0.01',
    maxVolume: '50',
    priceDecimals: 2,
    tradable: true,
  },
  {
    externalSymbol: 'EURUSD.m',
    description: 'Euro vs US Dollar',
    quoteCurrency: 'USD',
    contractSize: '100000',
    volumeStep: '0.01',
    minVolume: '0.01',
    maxVolume: '100',
    priceDecimals: 5,
    tradable: true,
  },
];

const DEFAULT_PRICES: Record<string, { bid: string; ask: string }> = {
  'XAUUSD.m': { bid: '4583.58', ask: '4583.72' },
  'EURUSD.m': { bid: '1.08412', ask: '1.08420' },
};

interface MockPosition {
  externalPositionId: string;
  externalAccountId: string;
  externalSymbol: string;
  side: 'BUY' | 'SELL';
  volume: string;
  entryPrice: string;
  stopLoss: string | null;
  takeProfit: string | null;
  openedAt: Date;
}

export class MockBrokerAdapter implements BrokerAdapter {
  readonly kind = 'MOCK';

  private connected = false;
  private authFailed = false;
  private readonly capabilities: BrokerCapabilities;
  private readonly instruments: readonly BrokerInstrument[];
  private readonly prices: Record<string, { bid: string; ask: string }>;
  private readonly accounts = new Map<string, { currency: string; balance: string }>();
  private readonly positions = new Map<string, MockPosition>();
  private readonly orders = new Map<string, BrokerOrder>();
  private readonly byClientOrderId = new Map<string, OrderResult>();
  private readonly fills: { accountId: string; fill: BrokerFill }[] = [];
  private readonly queue: MockBehaviour[] = [];
  private readonly listeners = new Set<(event: BrokerEvent) => void>();
  private readonly quoteSubscribers = new Set<(quote: BrokerQuote) => void>();
  private sequence = 0;
  private lastQuoteAt: Date | null = null;
  private lastOrderEventAt: Date | null = null;
  private readonly latencyMs: number;
  private readonly clock: () => Date;
  /** Every event ever emitted, so a test can replay or duplicate one. */
  readonly emitted: BrokerEvent[] = [];

  constructor(options: MockOptions = {}) {
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
    this.instruments = options.instruments ?? DEFAULT_INSTRUMENTS;
    this.prices = { ...DEFAULT_PRICES, ...options.prices };
    for (const account of options.accounts ?? [
      { id: 'MOCK-1001', currency: 'USD', balance: '100000' },
    ]) {
      this.accounts.set(account.id, { currency: account.currency, balance: account.balance });
    }
    this.latencyMs = options.latencyMs ?? 12;
    this.clock = options.clock ?? (() => new Date());
  }

  // ---- Scripting ---------------------------------------------------------

  /**
   * Give the venue an account, or change one it already has.
   *
   * Reconciliation is the reason this exists. Every other test reaches the
   * venue's state by placing an order *through* the platform, which by
   * construction leaves both sides agreeing — and a reconciliation test that
   * can only produce agreement proves nothing. This is how a test says "the
   * venue thinks the balance is 99,999.99" without the platform being told.
   */
  seedAccount(account: { externalAccountId: string; currency: string; balance: string }): this {
    this.accounts.set(account.externalAccountId, {
      currency: account.currency,
      balance: account.balance,
    });
    return this;
  }

  /**
   * Give the venue a position the platform has never heard of.
   *
   * The case worth being able to write a test for: a trade booked at the venue
   * and not here. It is the discrepancy that costs the most and the one a
   * platform is least able to notice on its own.
   */
  seedPosition(position: MockPosition): this {
    this.positions.set(position.externalPositionId, position);
    return this;
  }

  /** Give the venue a fill the platform never booked. */
  seedFill(externalAccountId: string, fill: BrokerFill): this {
    this.fills.push({ accountId: externalAccountId, fill });
    return this;
  }

  script(...behaviours: MockBehaviour[]): this {
    this.queue.push(...behaviours);
    return this;
  }

  /** Change a price and push it to subscribers, as a venue would. */
  setPrice(externalSymbol: string, bid: string, ask: string): void {
    this.prices[externalSymbol] = { bid, ask };
    const quote: BrokerQuote = { externalSymbol, bid, ask, at: this.clock() };
    this.lastQuoteAt = quote.at;
    for (const subscriber of this.quoteSubscribers) subscriber(quote);
  }

  /** Re-deliver an event the venue already sent, exactly as sent. */
  redeliver(externalEventId: string): void {
    const event = this.emitted.find((candidate) => candidate.externalEventId === externalEventId);
    if (event === undefined) throw new Error(`no emitted event ${externalEventId}`);
    for (const listener of this.listeners) listener(event);
  }

  /** Emit events in a scrambled order: the venue's queue caught up out of sequence. */
  emitOutOfOrder(events: readonly BrokerEvent[]): void {
    for (const event of [...events].reverse()) {
      for (const listener of this.listeners) listener(event);
    }
  }

  /** Simulate the venue closing the session. */
  dropConnection(reason = 'venue closed the session'): void {
    this.connected = false;
    this.emit(BrokerEventKind.CONNECTION_LOST, null, { reason });
  }

  // ---- BrokerAdapter -----------------------------------------------------

  async connect(credentials: BrokerCredentials): Promise<void> {
    await this.wait();
    if (credentials.fields['password'] === 'wrong' || credentials.fields['token'] === 'wrong') {
      this.authFailed = true;
      this.connected = false;
      throw new BrokerAdapterError(
        BrokerErrorCode.AUTH_FAILED,
        'the venue refused the credentials',
      );
    }
    this.authFailed = false;
    const was = this.connected;
    this.connected = true;
    if (!was) this.emit(BrokerEventKind.CONNECTION_RESTORED, null, {});
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async getCapabilities(): Promise<BrokerCapabilities> {
    return this.capabilities;
  }

  async healthcheck(): Promise<AdapterHealth> {
    const started = Date.now();
    await this.wait();
    return {
      state: this.authFailed
        ? ConnectionState.AUTH_FAILED
        : this.connected
          ? ConnectionState.CONNECTED
          : ConnectionState.DISCONNECTED,
      latencyMs: Date.now() - started,
      lastQuoteAt: this.lastQuoteAt,
      lastOrderEventAt: this.lastOrderEventAt,
      detail: null,
    };
  }

  async listInstruments(): Promise<readonly BrokerInstrument[]> {
    this.requireConnected();
    return this.instruments;
  }

  async subscribeQuotes(
    externalSymbols: readonly string[],
    onQuote: (quote: BrokerQuote) => void,
  ): Promise<() => Promise<void>> {
    this.requireConnected();
    if (!this.capabilities.supportsStreamingQuotes) {
      throw new BrokerAdapterError(
        BrokerErrorCode.UNSUPPORTED,
        'this venue does not stream quotes',
      );
    }
    const wanted = new Set(externalSymbols);
    const subscriber = (quote: BrokerQuote) => {
      if (wanted.has(quote.externalSymbol)) onQuote(quote);
    };
    this.quoteSubscribers.add(subscriber);
    for (const symbol of externalSymbols) {
      const price = this.prices[symbol];
      if (price === undefined) {
        throw new BrokerAdapterError(
          BrokerErrorCode.UNKNOWN_INSTRUMENT,
          `no such instrument ${symbol}`,
        );
      }
      const at = this.clock();
      this.lastQuoteAt = at;
      onQuote({ externalSymbol: symbol, bid: price.bid, ask: price.ask, at });
    }
    return async () => {
      this.quoteSubscribers.delete(subscriber);
    };
  }

  async getAccount(externalAccountId: string): Promise<BrokerAccountSnapshot> {
    this.requireConnected();
    const account = this.requireAccount(externalAccountId);
    return {
      externalAccountId,
      currency: account.currency,
      balance: account.balance,
      // The mock does not mark to market; equity equals balance. Enough for
      // sync to be exercised, and honest about what it is.
      equity: account.balance,
      usedMargin: '0',
      freeMargin: account.balance,
      at: this.clock(),
    };
  }

  async getPositions(externalAccountId: string): Promise<readonly BrokerPosition[]> {
    this.requireConnected();
    this.requireAccount(externalAccountId);
    return [...this.positions.values()].filter(
      (position) => position.externalAccountId === externalAccountId,
    );
  }

  async getOrders(externalAccountId: string): Promise<readonly BrokerOrder[]> {
    this.requireConnected();
    this.requireAccount(externalAccountId);
    return [...this.orders.values()].filter(
      (order) => order.externalAccountId === externalAccountId,
    );
  }

  async getExecutions(externalAccountId: string, since: Date): Promise<readonly BrokerFill[]> {
    this.requireConnected();
    this.requireAccount(externalAccountId);
    return this.fills
      .filter(
        (row) => row.accountId === externalAccountId && row.fill.at.getTime() >= since.getTime(),
      )
      .map((row) => row.fill);
  }

  async placeOrder(order: NormalisedOrder): Promise<OrderResult> {
    this.requireConnected();
    this.requireAccount(order.externalAccountId);
    const capability = this.capabilities[capabilityFor(order.type)];
    if (!capability) {
      throw new BrokerAdapterError(
        BrokerErrorCode.UNSUPPORTED,
        `this venue does not take ${order.type} orders`,
      );
    }
    if (this.prices[order.externalSymbol] === undefined) {
      throw new BrokerAdapterError(
        BrokerErrorCode.UNKNOWN_INSTRUMENT,
        `no such instrument ${order.externalSymbol}`,
      );
    }
    // Idempotent on the platform's id, as a good venue is.
    const already = this.byClientOrderId.get(order.clientOrderId);
    if (already !== undefined) return already;

    await this.wait();
    const behaviour: MockBehaviour = this.queue.shift() ?? { kind: 'fill' };
    const now = this.clock();

    switch (behaviour.kind) {
      case 'fill':
      case 'partial': {
        const volume = behaviour.kind === 'partial' ? behaviour.volume : order.volume;
        const result = this.fill(order, volume, behaviour.price, now);
        this.byClientOrderId.set(order.clientOrderId, result);
        return result;
      }
      case 'accept': {
        const externalOrderId = `MO-${randomUUID().slice(0, 8)}`;
        this.orders.set(externalOrderId, {
          externalOrderId,
          clientOrderId: order.clientOrderId,
          externalAccountId: order.externalAccountId,
          externalSymbol: order.externalSymbol,
          side: order.side,
          type: order.type,
          volume: order.volume,
          filledVolume: '0',
          price: order.price,
          status: 'WORKING',
          at: now,
        });
        const result: OrderResult = {
          outcome: 'ACCEPTED',
          clientOrderId: order.clientOrderId,
          externalOrderId,
          externalPositionId: null,
          fills: [],
          reason: null,
        };
        this.byClientOrderId.set(order.clientOrderId, result);
        return result;
      }
      case 'reject': {
        const result: OrderResult = {
          outcome: 'REJECTED',
          clientOrderId: order.clientOrderId,
          externalOrderId: null,
          externalPositionId: null,
          fills: [],
          reason: behaviour.reason,
        };
        this.byClientOrderId.set(order.clientOrderId, result);
        this.emit(BrokerEventKind.ORDER_REJECTED, order.externalAccountId, {
          clientOrderId: order.clientOrderId,
          reason: behaviour.reason,
        });
        return result;
      }
      case 'timeout-filled': {
        // The venue filled it; the platform hears nothing. `queryOrder` finds it.
        const result = this.fill(order, order.volume, behaviour.price, now);
        this.byClientOrderId.set(order.clientOrderId, result);
        return unknown(order.clientOrderId);
      }
      case 'timeout-lost':
        return unknown(order.clientOrderId);
      case 'disconnect':
        this.dropConnection('the venue dropped the session mid-order');
        throw new BrokerAdapterError(BrokerErrorCode.NOT_CONNECTED, 'disconnected', true);
      case 'rate-limit':
        throw new BrokerAdapterError(
          BrokerErrorCode.RATE_LIMITED,
          `slow down; retry after ${behaviour.retryAfterMs ?? 1000}ms`,
          true,
        );
      case 'auth-failed':
        this.authFailed = true;
        this.connected = false;
        throw new BrokerAdapterError(BrokerErrorCode.AUTH_FAILED, 'session no longer valid');
      case 'venue-error':
        throw new BrokerAdapterError(BrokerErrorCode.VENUE_ERROR, behaviour.message, true);
    }
  }

  async queryOrder(clientOrderId: string): Promise<OrderResult | null> {
    this.requireConnected();
    await this.wait();
    return this.byClientOrderId.get(clientOrderId) ?? null;
  }

  async cancelOrder(externalOrderId: string): Promise<void> {
    this.requireConnected();
    const order = this.orders.get(externalOrderId);
    if (order === undefined || order.status !== 'WORKING') {
      throw new BrokerAdapterError(
        BrokerErrorCode.UNKNOWN_ORDER,
        `no working order ${externalOrderId}`,
      );
    }
    this.orders.set(externalOrderId, { ...order, status: 'CANCELLED' });
    this.emit(BrokerEventKind.ORDER_CANCELLED, order.externalAccountId, { externalOrderId });
  }

  async modifyPosition(
    externalPositionId: string,
    protection: { stopLoss: string | null; takeProfit: string | null },
  ): Promise<void> {
    this.requireConnected();
    if (!this.capabilities.supportsModifyProtection) {
      throw new BrokerAdapterError(
        BrokerErrorCode.UNSUPPORTED,
        'this venue does not modify protection',
      );
    }
    const position = this.positions.get(externalPositionId);
    if (position === undefined) {
      throw new BrokerAdapterError(
        BrokerErrorCode.UNKNOWN_POSITION,
        `no position ${externalPositionId}`,
      );
    }
    position.stopLoss = protection.stopLoss;
    position.takeProfit = protection.takeProfit;
    this.emit(BrokerEventKind.POSITION_MODIFIED, position.externalAccountId, {
      externalPositionId,
      ...protection,
    });
  }

  async closePosition(externalPositionId: string, volume: string | null): Promise<OrderResult> {
    this.requireConnected();
    const position = this.positions.get(externalPositionId);
    if (position === undefined) {
      throw new BrokerAdapterError(
        BrokerErrorCode.UNKNOWN_POSITION,
        `no position ${externalPositionId}`,
      );
    }
    if (volume !== null && !this.capabilities.supportsPartialClose && volume !== position.volume) {
      throw new BrokerAdapterError(
        BrokerErrorCode.UNSUPPORTED,
        'this venue closes whole positions only',
      );
    }
    await this.wait();
    const now = this.clock();
    const closing = volume ?? position.volume;
    const price = this.exitPrice(position.externalSymbol, position.side);
    const remaining = subtract(position.volume, closing);
    const fill: BrokerFill = {
      externalExecutionId: `ME-${randomUUID().slice(0, 8)}`,
      volume: closing,
      price,
      at: now,
      commission: null,
    };
    this.fills.push({ accountId: position.externalAccountId, fill });
    if (remaining === '0') this.positions.delete(externalPositionId);
    else position.volume = remaining;
    this.emit(BrokerEventKind.POSITION_CLOSED, position.externalAccountId, {
      externalPositionId,
      volume: closing,
      remaining,
      price,
      externalExecutionId: fill.externalExecutionId,
    });
    return {
      outcome: 'FILLED',
      clientOrderId: `close-${externalPositionId}-${fill.externalExecutionId}`,
      externalOrderId: null,
      externalPositionId,
      fills: [fill],
      reason: null,
    };
  }

  onEvent(handler: (event: BrokerEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  // ---- Internals ---------------------------------------------------------

  private fill(
    order: NormalisedOrder,
    volume: string,
    price: string | undefined,
    now: Date,
  ): OrderResult {
    const filledAt =
      price ?? this.exitPrice(order.externalSymbol, order.side === 'BUY' ? 'SELL' : 'BUY');
    const externalPositionId = `MP-${randomUUID().slice(0, 8)}`;
    const externalOrderId = `MO-${randomUUID().slice(0, 8)}`;
    const fill: BrokerFill = {
      externalExecutionId: `ME-${randomUUID().slice(0, 8)}`,
      volume,
      price: filledAt,
      at: now,
      commission: null,
    };
    this.positions.set(externalPositionId, {
      externalPositionId,
      externalAccountId: order.externalAccountId,
      externalSymbol: order.externalSymbol,
      side: order.side,
      volume,
      entryPrice: filledAt,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      openedAt: now,
    });
    this.orders.set(externalOrderId, {
      externalOrderId,
      clientOrderId: order.clientOrderId,
      externalAccountId: order.externalAccountId,
      externalSymbol: order.externalSymbol,
      side: order.side,
      type: order.type,
      volume: order.volume,
      filledVolume: volume,
      price: order.price,
      status: 'FILLED',
      at: now,
    });
    this.fills.push({ accountId: order.externalAccountId, fill });
    const partial = volume !== order.volume;
    this.emit(BrokerEventKind.ORDER_FILLED, order.externalAccountId, {
      clientOrderId: order.clientOrderId,
      externalOrderId,
      externalPositionId,
      externalExecutionId: fill.externalExecutionId,
      volume,
      price: filledAt,
    });
    this.emit(BrokerEventKind.POSITION_OPENED, order.externalAccountId, {
      externalPositionId,
      externalSymbol: order.externalSymbol,
      side: order.side,
      volume,
      entryPrice: filledAt,
    });
    return {
      outcome: partial ? 'PARTIALLY_FILLED' : 'FILLED',
      clientOrderId: order.clientOrderId,
      externalOrderId,
      externalPositionId,
      fills: [fill],
      reason: null,
    };
  }

  private exitPrice(externalSymbol: string, side: 'BUY' | 'SELL'): string {
    const price = this.prices[externalSymbol];
    if (price === undefined) {
      throw new BrokerAdapterError(
        BrokerErrorCode.UNKNOWN_INSTRUMENT,
        `no such instrument ${externalSymbol}`,
      );
    }
    // Closing a BUY sells at the bid; closing a SELL buys at the ask.
    return side === 'BUY' ? price.bid : price.ask;
  }

  private emit(
    kind: BrokerEventKind,
    externalAccountId: string | null,
    payload: Record<string, unknown>,
  ): void {
    this.sequence += 1;
    const at = this.clock();
    if (kind !== BrokerEventKind.CONNECTION_LOST && kind !== BrokerEventKind.CONNECTION_RESTORED) {
      this.lastOrderEventAt = at;
    }
    const event: BrokerEvent = {
      externalEventId: `MEV-${String(this.sequence).padStart(8, '0')}`,
      sequence: this.sequence,
      at,
      kind,
      externalAccountId,
      payload,
    };
    this.emitted.push(event);
    for (const listener of this.listeners) listener(event);
  }

  private requireConnected(): void {
    if (this.authFailed) {
      throw new BrokerAdapterError(BrokerErrorCode.AUTH_FAILED, 'not authenticated');
    }
    if (!this.connected) {
      throw new BrokerAdapterError(BrokerErrorCode.NOT_CONNECTED, 'not connected', true);
    }
  }

  private requireAccount(externalAccountId: string): { currency: string; balance: string } {
    const account = this.accounts.get(externalAccountId);
    if (account === undefined) {
      throw new BrokerAdapterError(
        BrokerErrorCode.UNKNOWN_ACCOUNT,
        `no account ${externalAccountId}`,
      );
    }
    return account;
  }

  private async wait(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }
}

function unknown(clientOrderId: string): OrderResult {
  return {
    outcome: 'UNKNOWN',
    clientOrderId,
    externalOrderId: null,
    externalPositionId: null,
    fills: [],
    reason: 'no answer from the venue within the budget',
  };
}

function capabilityFor(type: NormalisedOrder['type']): keyof BrokerCapabilities {
  switch (type) {
    case 'MARKET':
      return 'supportsMarketOrders';
    case 'LIMIT':
      return 'supportsLimitOrders';
    case 'STOP':
      return 'supportsStopOrders';
    case 'STOP_LIMIT':
      return 'supportsStopLimitOrders';
  }
}

/**
 * Decimal subtraction on volume strings without a float. Volumes are at most
 * eight decimals; this scales, subtracts as integers, and formats back.
 */
function subtract(a: string, b: string): string {
  const scale = 8;
  const toInt = (value: string): bigint => {
    const [whole = '0', fraction = ''] = value.split('.');
    return BigInt(whole + fraction.padEnd(scale, '0').slice(0, scale));
  };
  const diff = toInt(a) - toInt(b);
  if (diff <= 0n) return '0';
  const text = diff.toString().padStart(scale + 1, '0');
  const whole = text.slice(0, -scale);
  const fraction = text.slice(-scale).replace(/0+$/, '');
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

export const mockBrokerAdapterFactory: BrokerAdapterFactory = {
  kind: 'MOCK',
  displayName: 'Mock venue (testing only)',
  documentation: '',
  credentialFields: [
    { key: 'login', label: 'Login', secret: false },
    { key: 'password', label: 'Password', secret: true },
    { key: 'server', label: 'Server', secret: false },
  ],
  create: (options) => new MockBrokerAdapter((options ?? {}) as MockOptions),
};
