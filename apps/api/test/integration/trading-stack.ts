import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import type { Tick } from '@tp/market-core';
import { SymbolsService } from '../../src/symbols/symbols.service';
import { QuoteService } from '../../src/market/quote.service';
import { ConversionService } from '../../src/market/conversion.service';
import { AccountStateService } from '../../src/trading/account-state.service';
import { RiskContextBuilder } from '../../src/trading/risk-context.builder';
import { OrdersService } from '../../src/trading/orders.service';
import { PositionsService } from '../../src/trading/positions.service';
import { TriggerEngineService } from '../../src/trading/trigger-engine.service';
import { SnapshotService } from '../../src/trading/snapshot.service';
import { TickBus } from '../../src/market/tick-bus';
import { AccountAccessService } from '../../src/accounts/account-access.service';
import { LedgerService } from '../../src/accounts/ledger.service';
import { EventsService } from '../../src/realtime/events.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { MetricsService } from '../../src/metrics/metrics.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { RedisService } from '../../src/redis/redis.service';

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
  };
  readonly publisher = { publish: async () => 1 };
  readonly subscriber = {
    subscribe: async () => 1,
    on: () => undefined,
    unsubscribe: async () => 1,
  };
}

export interface TradingStack {
  access: AccountAccessService;
  symbols: SymbolsService;
  quotes: QuoteService;
  orders: OrdersService;
  positions: PositionsService;
  accountState: AccountStateService;
  ledger: LedgerService;
  triggers: TriggerEngineService;
  snapshots: SnapshotService;
  /** Puts a price into the quote cache, as the market feed would. */
  publishQuote: (symbol: string, bid: string, ask: string, atMs?: number) => Promise<void>;
}

/**
 * Wires the trading services by hand.
 *
 * Nest's container is not used because Vitest's esbuild transform does not emit
 * decorator metadata; see the note in auth.test.ts. Explicit construction also
 * makes the dependency graph of the trading path visible in one place.
 */
export async function buildTradingStack(prisma: PrismaClient): Promise<TradingStack> {
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
    TRIGGER_ENGINE_ENABLED: true,
    // No throttle in tests: every tick must be acted on, or a stop-out
    // assertion would depend on how fast the test machine is.
    STOP_OUT_CHECK_INTERVAL_MS: 0,
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
  const riskContext = new RiskContextBuilder(prismaService);
  const ledger = new LedgerService();
  const access = new AccountAccessService(prismaService);
  const metrics = new MetricsService();
  const audit = new AuditService(prismaService);
  const events = new EventsService(redis);

  const orders = new OrdersService(
    prismaService,
    access,
    symbols,
    quotes,
    conversion,
    accountState,
    riskContext,
    ledger,
    metrics,
    audit,
    events,
    config as never,
  );
  const positions = new PositionsService(
    prismaService,
    access,
    symbols,
    quotes,
    conversion,
    ledger,
    audit,
    orders,
    events,
  );

  const triggers = new TriggerEngineService(
    config as never,
    prismaService,
    symbols,
    positions,
    orders,
    accountState,
    new TickBus(),
    metrics,
  );

  const publishQuote = async (symbol: string, bid: string, ask: string, atMs = Date.now()) => {
    const tick: Tick = { symbol, bid, ask, timestamp: atMs, volume: '1' };
    await quotes.publish(tick);
  };

  const snapshots = new SnapshotService(config as never, prismaService, accountState);

  return {
    access,
    symbols,
    quotes,
    orders,
    positions,
    accountState,
    ledger,
    triggers,
    snapshots,
    publishQuote,
  };
}
