import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isStopOut, toDecimal } from '@tp/financial-core';
import type { Tick } from '@tp/market-core';
import { evaluateProtectiveTrigger, nextHighWater, nextTrailingStop } from '@tp/trading-core';
import { CloseReason, isDomainError, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { SymbolsService } from '../symbols/symbols.service';
import { TickBus } from '../market/tick-bus';
import { MetricsService } from '../metrics/metrics.service';
import { AccountStateService } from './account-state.service';
import { PositionsService } from './positions.service';
import type { Env } from '../config/env.schema';

/**
 * Closes positions from price movement.
 *
 * This is the component that makes a stop-loss real: without it, SL and TP are
 * decorative fields that only take effect if the trader happens to be watching.
 *
 * Three things happen per tick, in this order:
 *
 *   1. Trailing stops ratchet — a level that has improved is persisted before
 *      anything is evaluated against it.
 *   2. Protective levels are evaluated on the executable exit price.
 *   3. Accounts holding the symbol are checked for stop-out.
 *
 * Order matters: evaluating a stale trailing level would close a position at a
 * stop the trader had already moved away from.
 */
@Injectable()
export class TriggerEngineService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TriggerEngineService.name);
  private unsubscribe: (() => void) | null = null;

  /**
   * Symbols with a pass in flight. A tick arriving mid-pass is dropped rather
   * than queued: the next tick carries a newer price, and processing a
   * superseded one would fire stops against a market that has moved on.
   */
  private readonly inFlight = new Set<string>();

  /** Last stop-out evaluation per account, to bound repeated valuations. */
  private readonly lastStopOutCheck = new Map<string, number>();

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly symbols: SymbolsService,
    private readonly positions: PositionsService,
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
    if (this.inFlight.has(tick.symbol)) return;
    this.inFlight.add(tick.symbol);
    try {
      await this.advanceTrailingStops(tick);
      await this.fireProtectiveOrders(tick);
      await this.checkStopOuts(tick);
    } finally {
      this.inFlight.delete(tick.symbol);
    }
  }

  private async advanceTrailingStops(tick: Tick): Promise<void> {
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

      const highWater = nextHighWater(
        position.side,
        position.highWaterPrice?.toString() ?? null,
        tick,
      );
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

  private async fireProtectiveOrders(tick: Tick): Promise<void> {
    const candidates = await this.prisma.position.findMany({
      where: {
        status: 'OPEN',
        symbol: { code: tick.symbol },
        OR: [{ stopLoss: { not: null } }, { takeProfit: { not: null } }],
      },
      select: { id: true, side: true, stopLoss: true, takeProfit: true },
    });

    for (const position of candidates) {
      const reason = evaluateProtectiveTrigger(
        position.side,
        {
          stopLoss: position.stopLoss?.toString() ?? null,
          takeProfit: position.takeProfit?.toString() ?? null,
        },
        tick,
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
