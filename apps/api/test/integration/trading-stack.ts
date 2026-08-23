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
import { LedgerService } from '../../src/accounts/ledger.service';
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
  readonly subscriber = {};
}

export interface TradingStack {
  symbols: SymbolsService;
  quotes: QuoteService;
  orders: OrdersService;
  positions: PositionsService;
  accountState: AccountStateService;
  ledger: LedgerService;
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
  } as never);

  const redis = new FakeRedis() as unknown as RedisService;
  const symbols = new SymbolsService(prismaService);
  await symbols.reload();

  const quotes = new QuoteService(redis, config as never);
  const conversion = new ConversionService(symbols, quotes);
  const accountState = new AccountStateService(prismaService, symbols, quotes, conversion);
  const riskContext = new RiskContextBuilder(prismaService);
  const ledger = new LedgerService();
  const metrics = new MetricsService();
  const audit = new AuditService(prismaService);

  const orders = new OrdersService(
    prismaService,
    symbols,
    quotes,
    conversion,
    accountState,
    riskContext,
    ledger,
    metrics,
    audit,
  );
  const positions = new PositionsService(
    prismaService,
    symbols,
    quotes,
    conversion,
    ledger,
    audit,
    orders,
  );

  const publishQuote = async (symbol: string, bid: string, ask: string, atMs = Date.now()) => {
    const tick: Tick = { symbol, bid, ask, timestamp: atMs, volume: '1' };
    await quotes.publish(tick);
  };

  return { symbols, quotes, orders, positions, accountState, ledger, publishQuote };
}
