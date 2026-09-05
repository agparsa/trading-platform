import type {
  AdapterHealth,
  BrokerAccountSnapshot,
  BrokerCapabilities,
  BrokerCredentials,
  BrokerEvent,
  BrokerFill,
  BrokerInstrument,
  BrokerOrder,
  BrokerPosition,
  BrokerQuote,
  NormalisedOrder,
  OrderResult,
} from './types';

/**
 * The port a broker connector implements.
 *
 * ## Why there is no real connector in this repository
 *
 * A connector is written against a venue's API documentation and tested
 * against its sandbox. Neither exists here. Writing one from memory of what
 * "a typical FX bridge" looks like would be inventing an integration, and the
 * specification is explicit: do not invent undocumented broker APIs; if the
 * specification is missing, stop that connector and report the blocker.
 *
 * So this interface exists, `MockBrokerAdapter` implements it for real — with
 * every failure the catalogue names, so the platform's handling of each is
 * tested — and the connector to a venue is **pending that venue's
 * documentation**. Adding one means implementing this interface, passing
 * `brokerAdapterContract`, and registering it in the registry with a note of
 * what documentation it was written against.
 *
 * ## The rules a connector lives by
 *
 * - **Never throw anything but `BrokerAdapterError`.** The platform acts on
 *   its `code`; a raw library error is a `VENUE_ERROR` the connector wraps.
 * - **Never log credentials, tokens or raw auth responses.**
 * - **`placeOrder` answers UNKNOWN, not an exception, when the request left
 *   and no answer came back.** The platform will call `queryOrder`.
 * - **Money and prices are strings.** The connector converts at its edge, with
 *   the venue's decimals, and never lets a float cross into the platform.
 * - **Every pushed event carries an `externalEventId`.** If the venue does not
 *   provide one, the connector derives a stable one from the venue's own
 *   fields (order id + status + timestamp) and says so in its documentation —
 *   it does not mint a random one, which would defeat dedupe.
 */
export interface BrokerAdapter {
  /** Stable machine name of the connector, e.g. `MOCK`. Stored on the connection. */
  readonly kind: string;

  /** Authenticate and open whatever session the venue needs. Idempotent. */
  connect(credentials: BrokerCredentials): Promise<void>;
  disconnect(): Promise<void>;

  /** Asked once after connecting; the platform stores the answer. */
  getCapabilities(): Promise<BrokerCapabilities>;
  /** Cheap, safe to call every few seconds. Must not throw for a bad state; report it. */
  healthcheck(): Promise<AdapterHealth>;

  listInstruments(): Promise<readonly BrokerInstrument[]>;
  /**
   * Push quotes for these symbols until the returned function is called.
   * Only when `supportsStreamingQuotes`; otherwise throws UNSUPPORTED.
   */
  subscribeQuotes(
    externalSymbols: readonly string[],
    onQuote: (quote: BrokerQuote) => void,
  ): Promise<() => Promise<void>>;

  getAccount(externalAccountId: string): Promise<BrokerAccountSnapshot>;
  getPositions(externalAccountId: string): Promise<readonly BrokerPosition[]>;
  getOrders(externalAccountId: string): Promise<readonly BrokerOrder[]>;
  /** Executions since a time, for reconciliation. Inclusive of the boundary. */
  getExecutions(externalAccountId: string, since: Date): Promise<readonly BrokerFill[]>;

  placeOrder(order: NormalisedOrder): Promise<OrderResult>;
  /**
   * The recovery query. Given the platform's own id, what does the venue
   * hold? `null` means the venue has never seen it — safe to resend.
   */
  queryOrder(clientOrderId: string): Promise<OrderResult | null>;
  cancelOrder(externalOrderId: string): Promise<void>;
  modifyPosition(
    externalPositionId: string,
    protection: { stopLoss: string | null; takeProfit: string | null },
  ): Promise<void>;
  /** `volume` null closes all of it. */
  closePosition(externalPositionId: string, volume: string | null): Promise<OrderResult>;

  /**
   * Subscribe to what the venue pushes. Returns an unsubscribe. Only when
   * `supportsOrderEvents`; otherwise the platform polls `getExecutions`.
   */
  onEvent(handler: (event: BrokerEvent) => void): () => void;
}

/** What builds an adapter: the registry holds one of these per kind. */
export interface BrokerAdapterFactory {
  readonly kind: string;
  /** Human name for the panel. */
  readonly displayName: string;
  /** What this connector was written against. Empty for the mock; required for a venue. */
  readonly documentation: string;
  /** The credential shape the connector needs, so the panel can ask for the right fields. */
  readonly credentialFields: readonly {
    readonly key: string;
    readonly label: string;
    readonly secret: boolean;
  }[];
  create(options?: Readonly<Record<string, unknown>>): BrokerAdapter;
}
