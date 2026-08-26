import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isStopOut, toDecimal } from '@tp/financial-core';
import { TickWindow, type CoalescedTick, type Tick } from '@tp/market-core';
import {
  bestExitInRange,
  evaluateProtectiveTriggerOverRange,
  favourableQuote,
  isExpired,
  isPendingOrderType,
  nextHighWater,
  nextTrailingStop,
  shouldTriggerPendingOverRange,
} from '@tp/trading-core';
import { CloseReason, isDomainError, OrderStatus, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { SymbolsService } from '../symbols/symbols.service';
import { TickBus } from '../market/tick-bus';
import { MetricsService } from '../metrics/metrics.service';
import { AccountStateService } from './account-state.service';
import { PositionsService } from './positions.service';
import { OrdersService } from './orders.service';
import type { Env } from '../config/env.schema';

/**
 * Closes positions from price movement.
 *
 * This is the component that makes a stop-loss real: without it, SL and TP are
 * decorative fields that only take effect if the trader happens to be watching.
 *
 * Four things happen per tick, in this order:
 *
 *   1. Trailing stops ratchet — a level that has improved is persisted before
 *      anything is evaluated against it.
 *   2. Protective levels are evaluated on the executable exit price.
 *   3. Resting orders are expired, then fired.
 *   4. Accounts holding the symbol are checked for stop-out.
 *
 * Order matters twice over. Evaluating a stale trailing level would close a
 * position at a stop the trader had already moved away from. And resting orders
 * are expired *before* they are fired, so an order that lapsed at midnight
 * cannot open a position on the first tick after it.
 *
 * Stop-out runs last, on purpose: an order that just filled has consumed margin,
 * and the account has to be judged on the state it is actually in.
 *
 * ## Ticks arriving mid-pass
 *
 * They used to be dropped. That was fast and had a real cost: if the market
 * printed a stop level on a dropped tick and moved on, the stop was never
 * evaluated against the price that should have fired it — a guarantee failing at
 * exactly the moment stops matter most.
 *
 * They are now **coalesced**. A tick arriving mid-pass folds into a per-symbol
 * window holding the extremes since the last pass; when the pass finishes, the
 * window is drained and another pass runs against those extremes. Memory is four
 * decimals per symbol regardless of tick rate, and the engine never falls behind
 * — the opposite failure a queue would have introduced.
 *
 * Detection asks "did the market trade through this level?", which the extremes
 * answer exactly. Execution still happens at the current price: the extreme has
 * already passed, and filling at a price nobody can deal at would be inventing a
 * fill.
 */
@Injectable()
export class TriggerEngineService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TriggerEngineService.name);
  private unsubscribe: (() => void) | null = null;

  /**
   * Symbols with a pass in flight. A tick arriving mid-pass folds into `window`
   * instead of starting a second, overlapping pass.
   */
  private readonly inFlight = new Set<string>();

  /** Everything the market printed while a pass was running. */
  private readonly window = new TickWindow();

  /** Last stop-out evaluation per account, to bound repeated valuations. */
  private readonly lastStopOutCheck = new Map<string, number>();

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly symbols: SymbolsService,
    private readonly positions: PositionsService,
    private readonly orders: OrdersService,
    private readonly accountState: AccountStateService,
    private readonly ticks: TickBus,
    private readonly metrics: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.getOrThrow('TRIGGER_ENGINE_ENABLED', { infer: true })) {
      this.logger.warn(
        'Trigger engine is disabled — stop-loss and take-profit will NOT fire on this instance',
      );
      return;
    }
    this.unsubscribe = this.ticks.subscribe((tick) => this.onTick(tick));
    this.logger.log('Trigger engine attached to the tick stream');
  }

  onApplicationShutdown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Exposed so tests can drive the engine without a live feed. */
  async onTick(tick: Tick): Promise<void> {
    this.window.observe(tick);
    // A pass is already running for this symbol. The tick is recorded, not lost,
    // and the running pass will pick it up when it drains again.
    if (this.inFlight.has(tick.symbol)) return;

    this.inFlight.add(tick.symbol);
    try {
      // Loop rather than return: ticks that arrived during a pass are drained by
      // the next iteration, so the engine catches up instead of leaving the last
      // of a burst unevaluated.
      for (;;) {
        const coalesced = this.window.drain(tick.symbol);
        if (coalesced === null) return;
        if (coalesced.observed > 1) {
          this.metrics.ticksCoalesced.inc({ symbol: tick.symbol }, coalesced.observed - 1);
        }
        await this.runPass(coalesced);
      }
    } finally {
      this.inFlight.delete(tick.symbol);
    }
  }

  private async runPass(coalesced: CoalescedTick): Promise<void> {
    await this.advanceTrailingStops(coalesced);
    await this.fireProtectiveOrders(coalesced);
    await this.workRestingOrders(coalesced);
    await this.checkStopOuts(coalesced.latest);
  }

  /**
   * Expire and fire the resting orders on this symbol.
   *
   * One indexed read per tick against the partial index on (symbolId, status).
   * Orders are fired oldest first, so two orders resting at the same price fill
   * in the order they were placed — the only fair rule when both are reached by
   * the same tick.
   */
  private async workRestingOrders(coalesced: CoalescedTick): Promise<void> {
    const tick = coalesced.latest;
    const spec = this.symbols.find(tick.symbol)?.spec;
    if (spec === undefined) return;

    const resting = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PENDING,
        symbol: { code: tick.symbol },
        type: { in: ['LIMIT', 'STOP'] },
      },
      select: { id: true, side: true, type: true, price: true, expiresAt: true },
      orderBy: { createdAt: 'asc' },
    });
    if (resting.length === 0) return;

    const now = Date.now();
    for (const order of resting) {
      if (isExpired({ timeInForce: '', expiresAt: order.expiresAt?.getTime() ?? null }, now)) {
        await this.orders.expirePending(order.id);
        continue;
      }
      const price = order.price?.toString();
      if (price === undefined) continue;
      if (!isPendingOrderType(order.type)) continue;
      if (!shouldTriggerPendingOverRange(order.type, order.side, price, coalesced)) continue;

      // `fillPending` claims the order itself, so a concurrent pass loses
      // rather than opening a second position from one order. It counts its own
      // outcome against `ordersSubmitted`, including a risk rejection.
      await this.orders.fillPending(order.id, tick);
    }
  }

  private async advanceTrailingStops(coalesced: CoalescedTick): Promise<void> {
    const tick = coalesced.latest;
    const spec = this.symbols.find(tick.symbol)?.spec;
    if (spec === undefined) return;

    const trailing = await this.prisma.position.findMany({
      where: {
        status: 'OPEN',
        symbol: { code: tick.symbol },
        trailingStopDistance: { not: null },
      },
      select: {
        id: true,
        side: true,
        version: true,
        stopLoss: true,
        highWaterPrice: true,
        trailingStopDistance: true,
      },
    });

    for (const position of trailing) {
      const distance = position.trailingStopDistance?.toString();
      if (distance === undefined) continue;

      // The best price in the window, not merely the latest: a trailing stop
      // that missed a spike it was busy during would then sit further from the
      // market than the trader asked for.
      const best = bestExitInRange(position.side, coalesced);
      const previous = position.highWaterPrice?.toString() ?? null;
      const highWater =
        previous === null
          ? best
          : nextHighWater(position.side, previous, favourableQuote(position.side, coalesced));
      const moved = nextTrailingStop(
        spec,
        position.side,
        distance,
        highWater,
        position.stopLoss?.toString() ?? null,
      );

      if (moved === null && highWater === (position.highWaterPrice?.toString() ?? null)) continue;

      // Version-guarded: if the trader moved the stop themselves between the
      // read and this write, their value wins and the ratchet retries next tick.
      await this.prisma.position.updateMany({
        where: { id: position.id, status: 'OPEN', version: position.version },
        data: {
          highWaterPrice: highWater,
          ...(moved === null ? {} : { stopLoss: moved }),
          version: { increment: 1 },
        },
      });
    }
  }

  private async fireProtectiveOrders(coalesced: CoalescedTick): Promise<void> {
    const tick = coalesced.latest;
    const candidates = await this.prisma.position.findMany({
      where: {
        status: 'OPEN',
        symbol: { code: tick.symbol },
        OR: [{ stopLoss: { not: null } }, { takeProfit: { not: null } }],
      },
      select: { id: true, side: true, stopLoss: true, takeProfit: true },
    });

    for (const position of candidates) {
      const reason = evaluateProtectiveTriggerOverRange(
        position.side,
        {
          stopLoss: position.stopLoss?.toString() ?? null,
          takeProfit: position.takeProfit?.toString() ?? null,
        },
        coalesced,
      );
      if (reason === null) continue;
      await this.closeTriggered(position.id, reason, tick);
    }
  }

  /**
   * Liquidates accounts that have fallen through their stop-out level.
   *
   * Positions are closed largest-margin-first and one at a time, re-valuing
   * after each: closing one position frees margin, and the account frequently
   * recovers before the rest need to go. Dumping the whole book at once would
   * cost the trader positions that did not have to be closed.
   */
  private async checkStopOuts(tick: Tick): Promise<void> {
    const throttleMs = this.config.getOrThrow('STOP_OUT_CHECK_INTERVAL_MS', { infer: true });
    const now = Date.now();

    const exposed = await this.prisma.position.findMany({
      where: { status: 'OPEN', symbol: { code: tick.symbol } },
      select: { accountId: true },
      distinct: ['accountId'],
    });

    for (const { accountId } of exposed) {
      const last = this.lastStopOutCheck.get(accountId) ?? 0;
      if (now - last < throttleMs) continue;
      this.lastStopOutCheck.set(accountId, now);
      await this.liquidateIfRequired(accountId);
    }
  }

  private async liquidateIfRequired(accountId: string): Promise<void> {
    const settings = await this.prisma.accountSettings.findUnique({ where: { accountId } });
    if (settings === null) return;
    const stopOutLevel = settings.stopOutLevelPercent.toString();

    // Bounded so a pathological account cannot occupy the tick loop.
    for (let pass = 0; pass < 20; pass += 1) {
      const valuation = await this.accountState.valuate(accountId);
      if (!isStopOut(valuation.state, stopOutLevel)) return;

      const worst = [...valuation.positions].sort((a, b) =>
        toDecimal(b.margin.amount).comparedTo(toDecimal(a.margin.amount)),
      )[0];
      if (worst === undefined) return;

      this.logger.warn(
        {
          accountId,
          marginLevel: valuation.state.marginLevel?.toString(),
          stopOutLevel,
          positionId: worst.positionId,
        },
        'Stop-out: liquidating a position',
      );

      await this.prisma.riskEvent.create({
        data: {
          accountId,
          rule: 'stop-out',
          code: 'STOP_OUT',
          severity: 'CRITICAL',
          message: `Margin level ${valuation.state.marginLevel?.toDecimalPlaces(2).toString() ?? 'n/a'}% reached the ${stopOutLevel}% stop-out level`,
          snapshot: {
            equity: valuation.state.equity.toString(),
            usedMargin: valuation.state.usedMargin.toString(),
            freeMargin: valuation.state.freeMargin.toString(),
            liquidated: worst.positionId,
          },
        },
      });

      const closed = await this.closeTriggered(worst.positionId, CloseReason.LIQUIDATION, null);
      // If the close could not proceed, stop rather than spinning: the next
      // tick will try again with a fresh price.
      if (!closed) return;
    }
  }

  private async closeTriggered(
    positionId: string,
    reason: CloseReason,
    tick: Tick | null,
  ): Promise<boolean> {
    try {
      const result = await this.positions.closeForSystem(positionId, null, reason);
      this.metrics.ordersSubmitted.inc({
        symbol: tick?.symbol ?? 'unknown',
        type: 'TRIGGER',
        outcome: reason.toLowerCase(),
      });
      this.logger.log(
        { positionId, reason, exitPrice: result.exitPrice, netPnl: result.netPnl },
        'Position closed by the trigger engine',
      );
      return true;
    } catch (error) {
      // Losing the CLOSING race is the expected outcome when a trader closed
      // manually a moment earlier, and is not an error worth alarming about.
      if (
        isDomainError(error) &&
        (error.code === TradingErrorCode.POSITION_ALREADY_CLOSING ||
          error.code === TradingErrorCode.POSITION_NOT_FOUND)
      ) {
        return false;
      }
      this.logger.error({ err: error, positionId, reason }, 'Trigger close failed');
      return false;
    }
  }
}
