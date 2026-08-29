import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Tick } from '@tp/market-core';
import { RiskState, WsChannel } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { TickBus } from '../market/tick-bus';
import { AccountStateService } from '../trading/account-state.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ExposureIndex } from './exposure-index';
import { RealtimeGateway } from './realtime.gateway';
import type { Env } from '../config/env.schema';

/**
 * The thresholds that decide an account's risk state.
 *
 * Cached because they are configuration, not money: they change when an operator
 * changes them, not when the market moves, and re-reading them on every
 * valuation would be a query per account per interval to learn a number that has
 * not moved in weeks.
 *
 * A stale threshold can only make a *notification* early or late by up to the
 * TTL. It cannot affect a balance, and it is emphatically not what the trigger
 * engine uses to decide a stop-out — that reads the row fresh, inside the
 * transaction, every time.
 */
const RISK_THRESHOLD_TTL_MS = 60_000;

interface RiskThresholds {
  marginCall: string | null;
  stopOut: string | null;
  /** Who to tell. Read alongside the thresholds so a notice costs no extra query. */
  userId: string | null;
  accountNumber: string | null;
  readAt: number;
}

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
  private unsubscribeAbandoned: (() => void) | null = null;
  private readonly lastValuedAt = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  /** Last risk state announced per account, so only transitions are sent. */
  private readonly lastRiskState = new Map<string, RiskState>();
  private readonly thresholds = new Map<string, RiskThresholds>();

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly accountState: AccountStateService,
    private readonly gateway: RealtimeGateway,
    private readonly ticks: TickBus,
    private readonly exposure: ExposureIndex,
    private readonly notifications: NotificationsService,
  ) {}

  onApplicationBootstrap(): void {
    this.unsubscribe = this.ticks.subscribe((tick) => this.onTick(tick));
    this.unsubscribeAbandoned = this.gateway.onAccountAbandoned((accountId) =>
      this.forget(accountId),
    );
    this.logger.log('Realtime valuation attached to the tick stream');
  }

  onApplicationShutdown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeAbandoned?.();
    this.unsubscribeAbandoned = null;
  }

  /** Exposed so tests can drive it without a live feed. */
  async onTick(tick: Tick): Promise<void> {
    const listening = new Set([
      ...this.gateway.listeningAccounts(WsChannel.ACCOUNT),
      ...this.gateway.listeningAccounts(WsChannel.PNL),
    ]);
    if (listening.size === 0) return;

    const now = Date.now();

    /**
     * From memory, not from a query.
     *
     * This used to be a `position.findMany` on every tick — and, worse, it ran
     * *before* the throttle below, so raising the valuation interval did not
     * reduce it at all. The index answers the same question without the round
     * trip; it is a routing hint and never an input to money, which is what
     * makes holding it in memory safe. See ExposureIndex.
     */
    const exposed = await this.exposure.exposedTo(tick.symbol, listening, now);

    const interval = this.config.getOrThrow('REALTIME_VALUATION_INTERVAL_MS', { infer: true });

    for (const accountId of exposed) {
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

    await this.announceRiskState(accountId, valuation.state.marginLevel);
  }

  /**
   * Announces a change in how close the account is to the levels that stop it
   * trading — and says nothing at all when nothing changed.
   *
   * A margin level sitting at 94% for an hour produces one frame, not fourteen
   * thousand. That is what makes it safe for §31's notification layer to raise
   * an alert straight from this event without any de-duplication of its own: the
   * de-duplication is the semantics of the event, not a filter bolted on after.
   */
  private async announceRiskState(
    accountId: string,
    marginLevel: { toString(): string } | null,
  ): Promise<void> {
    const thresholds = await this.thresholdsFor(accountId);
    const state = classifyRiskState(marginLevel, thresholds);

    const previous = this.lastRiskState.get(accountId) ?? RiskState.NORMAL;
    if (state === previous) return;
    this.lastRiskState.set(accountId, state);

    this.gateway.sendToAccount(accountId, WsChannel.ACCOUNT, 'risk.updated', {
      accountId,
      state,
      previous,
      marginLevel: marginLevel === null ? null : marginLevel.toString(),
      marginCallLevelPercent: thresholds.marginCall,
      stopOutLevelPercent: thresholds.stopOut,
    });

    /**
     * And a notice that survives the browser being shut.
     *
     * The frame above reaches whoever is looking. Crossing into a margin call is
     * precisely the moment a trader is *not* looking — that is what makes it
     * worth telling them — so it is written down as well. Recovering to NORMAL
     * is not: it is good news that needs no chasing, and a bell that rings for
     * every recovery teaches people to ignore it.
     */
    if (state !== RiskState.NORMAL && thresholds.userId !== null) {
      const level = marginLevel === null ? 'unknown' : `${marginLevel.toString()}%`;
      const account = thresholds.accountNumber ?? accountId;
      await this.notifications.raise({
        userId: thresholds.userId,
        kind: state === RiskState.STOP_OUT ? 'risk.stop_out' : 'risk.margin_call',
        severity: state === RiskState.STOP_OUT ? 'CRITICAL' : 'WARNING',
        title:
          state === RiskState.STOP_OUT
            ? `Account ${account} has reached its stop-out level`
            : `Account ${account} is on margin call`,
        body:
          state === RiskState.STOP_OUT
            ? `The margin level is ${level}, at or below the stop-out level of ${thresholds.stopOut ?? '—'}%. Positions may be closed automatically.`
            : `The margin level is ${level}, at or below the margin-call level of ${thresholds.marginCall ?? '—'}%. Add funds or reduce exposure.`,
        data: { marginLevel: marginLevel?.toString() ?? null, state, previous },
        accountId,
        /**
         * One notice per account per state per minute.
         *
         * Transitions are already de-duplicated in memory, but this process is
         * not the only one: two API instances each watching the same account
         * would each see the crossing. The key makes the second a no-op at the
         * database rather than a second bell.
         */
        dedupeKey: `${accountId}:${state}:${Math.floor(Date.now() / 60_000)}`,
      });
    }
  }

  /**
   * The account's risk thresholds, cached.
   *
   * These are configuration — an operator changes them, the market does not —
   * so re-reading them on every valuation would be a query per account per
   * interval to learn a number that has not moved in weeks.
   *
   * Being up to a minute stale can only make a *notification* early or late. It
   * cannot affect a balance, and it is emphatically not what decides a stop-out:
   * the trigger engine reads the row fresh, inside its transaction, every time.
   */
  private async thresholdsFor(accountId: string): Promise<RiskThresholds> {
    const cached = this.thresholds.get(accountId);
    const now = Date.now();
    if (cached !== undefined && now - cached.readAt < RISK_THRESHOLD_TTL_MS) return cached;

    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { userId: true, number: true, settings: true },
    });
    const fresh: RiskThresholds = {
      marginCall: account?.settings?.marginCallLevelPercent?.toString() ?? null,
      stopOut: account?.settings?.stopOutLevelPercent?.toString() ?? null,
      userId: account?.userId ?? null,
      accountNumber: account?.number ?? null,
      readAt: now,
    };
    this.thresholds.set(accountId, fresh);
    return fresh;
  }

  /**
   * Forgets everything held for an account nobody is watching any more.
   *
   * Called when the last socket for an account disconnects. Without it every map
   * here grows for the life of the process — small, unbounded, and invisible to
   * a soak that runs for fifteen minutes.
   */
  forget(accountId: string): void {
    this.lastValuedAt.delete(accountId);
    this.lastRiskState.delete(accountId);
    this.thresholds.delete(accountId);
    this.exposure.forget(accountId);
  }
}

/**
 * Which risk state a margin level falls in.
 *
 * Exported and pure so it can be tested without a database, a socket or a
 * clock. The comparison is on decimal strings via `Number` deliberately: these
 * are threshold percentages being compared for *display and notification*, never
 * money, and the stop-out that actually closes a position is decided elsewhere
 * with decimal arithmetic.
 *
 * A null margin level means no margin is used — an account with no positions is
 * not in trouble, it is idle.
 */
export function classifyRiskState(
  marginLevel: { toString(): string } | null,
  thresholds: { marginCall: string | null; stopOut: string | null },
): RiskState {
  if (marginLevel === null) return RiskState.NORMAL;
  const level = Number(marginLevel.toString());
  if (!Number.isFinite(level)) return RiskState.NORMAL;

  const stopOut = thresholds.stopOut === null ? null : Number(thresholds.stopOut);
  if (stopOut !== null && Number.isFinite(stopOut) && level <= stopOut) return RiskState.STOP_OUT;

  const marginCall = thresholds.marginCall === null ? null : Number(thresholds.marginCall);
  if (marginCall !== null && Number.isFinite(marginCall) && level <= marginCall) {
    return RiskState.MARGIN_CALL;
  }

  return RiskState.NORMAL;
}
