import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Tick } from '@tp/market-core';
import { WsChannel } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { TickBus } from '../market/tick-bus';
import { AccountStateService } from '../trading/account-state.service';
import { RealtimeGateway } from './realtime.gateway';
import type { Env } from '../config/env.schema';

/**
 * Pushes account state and floating P&L as the market moves.
 *
 * The expensive part of a live terminal is not the quote stream — it is
 * re-valuing accounts. This service bounds that work in two ways:
 *
 *  1. Only accounts with a socket actually listening are valued. Cost scales
 *     with users online, not with users registered.
 *  2. Each account is valued at most once per `REALTIME_VALUATION_INTERVAL_MS`.
 *     A tick every 250ms does not need to produce four valuations a second of
 *     numbers a human cannot read that fast.
 *
 * This is throttling, not polling: nothing runs when the market is still, and
 * the trigger engine — which must see every tick — is untouched by it.
 */
@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeService.name);
  private unsubscribe: (() => void) | null = null;
  private readonly lastValuedAt = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly accountState: AccountStateService,
    private readonly gateway: RealtimeGateway,
    private readonly ticks: TickBus,
  ) {}

  onApplicationBootstrap(): void {
    this.unsubscribe = this.ticks.subscribe((tick) => this.onTick(tick));
    this.logger.log('Realtime valuation attached to the tick stream');
  }

  onApplicationShutdown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Exposed so tests can drive it without a live feed. */
  async onTick(tick: Tick): Promise<void> {
    const listening = new Set([
      ...this.gateway.listeningAccounts(WsChannel.ACCOUNT),
      ...this.gateway.listeningAccounts(WsChannel.PNL),
    ]);
    if (listening.size === 0) return;

    const exposed = await this.prisma.position.findMany({
      where: {
        status: { in: ['OPEN', 'CLOSING'] },
        accountId: { in: [...listening] },
        symbol: { code: tick.symbol },
      },
      select: { accountId: true },
      distinct: ['accountId'],
    });

    const interval = this.config.getOrThrow('REALTIME_VALUATION_INTERVAL_MS', { infer: true });
    const now = Date.now();

    for (const { accountId } of exposed) {
      if (now - (this.lastValuedAt.get(accountId) ?? 0) < interval) continue;
      // A valuation already running for this account means the previous tick is
      // still being served; skipping is correct, the next tick is newer anyway.
      if (this.inFlight.has(accountId)) continue;

      this.lastValuedAt.set(accountId, now);
      this.inFlight.add(accountId);
      try {
        await this.pushValuation(accountId);
      } catch (error) {
        this.logger.error({ err: error, accountId }, 'Realtime valuation failed');
      } finally {
        this.inFlight.delete(accountId);
      }
    }
  }

  private async pushValuation(accountId: string): Promise<void> {
    const valuation = await this.accountState.valuate(accountId);

    this.gateway.sendToAccount(
      accountId,
      WsChannel.ACCOUNT,
      'account.updated',
      this.accountState.toDto(valuation),
    );

    for (const position of valuation.positions) {
      this.gateway.sendToAccount(accountId, WsChannel.PNL, 'pnl.updated', {
        accountId,
        positionId: position.positionId,
        symbol: position.symbol,
        floatingPnl: position.floatingPnl.toString(),
        // Sent alongside the floating figure rather than derived in the browser:
        // a net number the server never computed is a number nobody can
        // reconcile against the ledger after a dispute.
        netPnl: position.netPnl.toString(),
        currentPrice: position.currentPrice,
        stale: position.stale,
      });
    }
  }

  /** Forgets throttle state for accounts nobody is watching any more. */
  forget(accountId: string): void {
    this.lastValuedAt.delete(accountId);
  }
}
