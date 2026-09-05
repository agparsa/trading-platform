import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import type { Tick } from '@tp/market-core';
import { SymbolsService } from '../../src/symbols/symbols.service';
import { QuoteService } from '../../src/market/quote.service';
import { ConversionService } from '../../src/market/conversion.service';
import { AccountStateService } from '../../src/trading/account-state.service';
import { RiskContextBuilder } from '../../src/trading/risk-context.builder';
import { RiskLimitsService } from '../../src/trading/risk-limits.service';
import { OrdersService } from '../../src/trading/orders.service';
import { PositionsService } from '../../src/trading/positions.service';
import { TriggerEngineService } from '../../src/trading/trigger-engine.service';
import { SnapshotService } from '../../src/trading/snapshot.service';
import { VenueRecoveryService } from '../../src/trading/venue-recovery.service';
import { TickBus } from '../../src/market/tick-bus';
import { AccountAccessService } from '../../src/accounts/account-access.service';
import { KillSwitchService } from '../../src/operations/kill-switch.service';
import { LedgerService } from '../../src/accounts/ledger.service';
import { EventsService } from '../../src/realtime/events.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { MetricsService } from '../../src/metrics/metrics.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { RedisService } from '../../src/redis/redis.service';
import { TradingThrottle } from '../../src/trading/trading-throttle.service';
import { OutboxService } from '../../src/outbox/outbox.service';
import { ExternalExecutionService } from '../../src/trading/external-execution.service';
import { BrokerConnectionsService } from '../../src/broker-connections/broker-connections.service';
import { BrokerMappingService } from '../../src/broker-connections/broker-mapping.service';
import { BrokerAdapterRegistry } from '@tp/broker-sdk';
import { SecretBox, generateEncryptionKey, parseEncryptionKeys } from '@tp/crypto-core';
import type { TenantResolver } from '../../src/tenancy/tenant-resolver.service';
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_SLUG } from './harness';

/**
 * An in-memory stand-in for Redis.
 *
 * The quote cache is the only Redis use on this path, and its contract is
 * get/set with a TTL. A real Redis would add a dependency to these tests without
 * exercising any behaviour they are checking — unlike PostgreSQL, whose locking
 * and constraints are exactly what is under test.
 */
class FakeRedis {
  private readonly store = new Map<string, string>();
  readonly client = {
    set: async (key: string, value: string) => {
      this.store.set(key, value);
      return 'OK';
    },
    get: async (key: string) => this.store.get(key) ?? null,
    del: async (key: string) => (this.store.delete(key) ? 1 : 0),
    // The order-path throttle: one counter per key. Tests that want to hit a
    // ceiling set the limit low through the config rather than looping.
    incr: async (key: string) => {
      const next = Number(this.store.get(key) ?? '0') + 1;
      this.store.set(key, String(next));
      return next;
    },
    expire: async () => 1,
  };
  readonly publisher = { publish: async () => 1 };
  readonly subscriber = {
    subscribe: async () => 1,
    on: () => undefined,
    unsubscribe: async () => 1,
  };
}

export interface TradingStack {
  /** The fake Redis behind the quote cache, so a test can take a price away entirely. */
  redis: { client: { del(key: string): Promise<number> } };
  access: AccountAccessService;
  killSwitch: KillSwitchService;
  symbols: SymbolsService;
  quotes: QuoteService;
  orders: OrdersService;
  positions: PositionsService;
  accountState: AccountStateService;
  ledger: LedgerService;
  triggers: TriggerEngineService;
  snapshots: SnapshotService;
  /** The hierarchy resolver, for tests about ceilings above an account. */
  riskLimits: RiskLimitsService;
  /** The sweep that asks venues about orders whose answers were lost. */
  recovery: VenueRecoveryService;
  /** Puts a price into the quote cache, as the market feed would. */
  conversion: ConversionService;
  publishQuote: (symbol: string, bid: string, ask: string, atMs?: number) => Promise<void>;
  /** The external execution path and what it needs, for tests about venues. */
  external: ExternalExecutionService;
  connections: BrokerConnectionsService;
  mappings: BrokerMappingService;
  registry: BrokerAdapterRegistry;
}

/**
 * Wires the trading services by hand.
 *
 * Nest's container is not used because Vitest's esbuild transform does not emit
 * decorator metadata; see the note in auth.test.ts. Explicit construction also
 * makes the dependency graph of the trading path visible in one place.
 */
export interface TradingStackOptions {
  /** Order-path ceilings; effectively unlimited unless a test is about them. */
  readonly orderRateLimitPerAccount?: number;
  readonly orderRateLimitPerTenant?: number;
}

export async function buildTradingStack(
  prisma: PrismaClient,
  options: TradingStackOptions = {},
): Promise<TradingStack> {
  const prismaService = prisma as unknown as PrismaService;
  const config = new ConfigService<Record<string, unknown>, true>({
    QUOTE_MAX_AGE_MS: 5_000,
    IDEMPOTENCY_KEY_TTL_SECONDS: 86_400,
    DEFAULT_ACCOUNT_CURRENCY: 'USD',
    DEFAULT_ACCOUNT_LEVERAGE: 100,
    DEMO_ACCOUNT_INITIAL_BALANCE: '100000',
    TRADING_SERVER_TIMEZONE: 'UTC',
    // Snapshots are driven explicitly in tests, never on a timer.
    ACCOUNT_SNAPSHOT_INTERVAL_MS: 0,
    // Recovery passes are driven explicitly too, and with no grace: a test
    // that had to sleep five seconds to see a sweep would be a slow test
    // proving something about `setTimeout`.
    VENUE_RECOVERY_INTERVAL_MS: 0,
    VENUE_RECOVERY_GRACE_MS: 0,
    TRIGGER_ENGINE_ENABLED: true,
    // No throttle in tests: every tick must be acted on, or a stop-out
    // assertion would depend on how fast the test machine is.
    STOP_OUT_CHECK_INTERVAL_MS: 0,
    ORDER_RATE_LIMIT_PER_ACCOUNT_PER_MINUTE: options.orderRateLimitPerAccount ?? 100_000,
    ORDER_RATE_LIMIT_PER_TENANT_PER_MINUTE: options.orderRateLimitPerTenant ?? 100_000,
  } as never);

  const redis = new FakeRedis() as unknown as RedisService;
  const symbols = new SymbolsService(prismaService);
  await symbols.reload();

  const quotes = new QuoteService(redis, config as never);
  const conversion = new ConversionService(symbols, quotes);
  const accountState = new AccountStateService(
    prismaService,
    symbols,
    quotes,
    conversion,
    config as never,
  );
  const riskLimits = new RiskLimitsService(prismaService);
  const riskContext = new RiskContextBuilder(prismaService, riskLimits);
  const ledger = new LedgerService();
  const access = new AccountAccessService(prismaService);
  const metrics = new MetricsService();
  const audit = new AuditService(prismaService);
  const killSwitch = new KillSwitchService(prismaService, audit);
  const events = new EventsService(redis);
  const throttle = new TradingThrottle(redis, config as never);
  const outbox = new OutboxService();
  /**
   * The external path, wired with a registry the test controls. Accounts in
   * these tests are INTERNAL unless a test says otherwise, so this exists to
   * be reachable rather than to be used by most of them.
   */
  const registry = new BrokerAdapterRegistry();
  const connections = new BrokerConnectionsService(
    prismaService,
    audit,
    new SecretBox(parseEncryptionKeys(generateEncryptionKey('test'))) as never,
    registry,
  );
  const mappings = new BrokerMappingService(prismaService, audit, connections);
  const external = new ExternalExecutionService(
    prismaService,
    connections,
    mappings,
    audit,
    events,
    outbox,
  );

  const orders = new OrdersService(
    prismaService,
    access,
    killSwitch,
    symbols,
    quotes,
    conversion,
    accountState,
    riskContext,
    ledger,
    metrics,
    audit,
    events,
    outbox,
    external,
    throttle,
    config as never,
  );
  const positions = new PositionsService(
    prismaService,
    access,
    killSwitch,
    symbols,
    quotes,
    conversion,
    ledger,
    audit,
    orders,
    events,
    accountState,
    throttle,
  );

  /**
   * A stand-in resolver, because the engine now re-enters each row's tenant.
   *
   * The tests run in one tenant, so this answers with it. It is a real object
   * rather than a mock returning `undefined`: an engine that silently skipped
   * every row because the resolver said nothing would pass a test asserting a
   * stop *did not* fire, which is the assertion these suites are full of.
   */
  const tenants = {
    byId: (tenantId: string) =>
      Promise.resolve(
        tenantId === DEFAULT_TENANT_ID ? { tenantId, slug: DEFAULT_TENANT_SLUG } : null,
      ),
  } as unknown as TenantResolver;

  const triggers = new TriggerEngineService(
    config as never,
    prismaService,
    symbols,
    positions,
    orders,
    accountState,
    new TickBus(),
    metrics,
    tenants,
  );

  /**
   * Stand in for the feed.
   *
   * The cached price is dropped first so a test can put the market wherever it
   * needs it, including *backwards* — which `QuoteService.publish` otherwise
   * refuses, because an out-of-order tick arriving from a real feed must not
   * rewind the price. Tests need to say "the last price for this symbol is an
   * hour old" and that is not an out-of-order delivery, it is a feed that
   * stopped.
   *
   * The ordering rule itself is proved directly in `quote-ordering.test.ts`
   * rather than incidentally here.
   */
  const publishQuote = async (symbol: string, bid: string, ask: string, atMs = Date.now()) => {
    quotes.forget(symbol);
    const tick: Tick = { symbol, bid, ask, timestamp: atMs, volume: '1' };
    await quotes.publish(tick);
  };

  const snapshots = new SnapshotService(config as never, prismaService, accountState, tenants);
  const recovery = new VenueRecoveryService(config as never, prismaService, external, tenants);

  return {
    redis: redis as unknown as { client: { del(key: string): Promise<number> } },
    external,
    connections,
    mappings,
    registry,
    access,
    killSwitch,
    symbols,
    quotes,
    conversion,
    orders,
    positions,
    accountState,
    ledger,
    triggers,
    snapshots,
    riskLimits,
    recovery,
    publishQuote,
  };
}
