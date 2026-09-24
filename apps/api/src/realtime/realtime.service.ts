import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Tick } from '@tp/market-core';
import {
  type PnlUpdatePayload,
  RiskState,
  type RiskUpdatePayload,
  WsChannel,
} from '@tp/shared-types';
import { withTenant, type TenantContext } from '@tp/tenancy';
import { PrismaService } from '../prisma/prisma.service';
import { TickBus } from '../market/tick-bus';
import { AccountStateService } from '../trading/account-state.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MetricsService } from '../metrics/metrics.service';
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

/**
 * How many accounts are valued at once in a pass.
 *
 * Serially, a hundred accounts is a hundred round trips and the pass overruns
 * the interval it is meant to run at. All at once, a busy platform opens a
 * hundred simultaneous connections to price screens nobody is waiting on,
 * competing with the orders that *are* being waited on.
 */
const VALUATION_CONCURRENCY = 8;

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
  /**
   * Instruments that have moved since the last valuation pass, against the
   * timestamp of the *oldest* tick not yet reflected in a frame.
   *
   * Oldest rather than newest, deliberately. The question the latency metric
   * answers is "how long has the trader's screen been wrong", and that clock
   * starts at the first move nobody has been told about, not the last one.
   */
  private readonly dirtySymbols = new Map<string, number>();
  private drainTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly accountState: AccountStateService,
    private readonly gateway: RealtimeGateway,
    private readonly ticks: TickBus,
    private readonly exposure: ExposureIndex,
    private readonly notifications: NotificationsService,
    private readonly metrics: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    this.stopped = false;
    this.unsubscribe = this.ticks.subscribe((tick) => {
      this.onTick(tick);
    });
    this.scheduleDrain();
    this.unsubscribeAbandoned = this.gateway.onAccountAbandoned((accountId) =>
      this.forget(accountId),
    );
    this.logger.log('Realtime valuation attached to the tick stream');
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.drainTimer !== null) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeAbandoned?.();
    this.unsubscribeAbandoned = null;
  }

  /**
   * A tick arrived. Note which instrument moved, and return.
   *
   * ## Why this does no work
   *
   * `TickBus` awaits its handlers in order, deliberately: a stop must be
   * evaluated against every price the market printed, in the order it printed
   * them. That makes anything slow in a handler *back-pressure on the feed
   * itself*.
   *
   * This used to value every exposed account here, inline. A load run at a
   * hundred traders found what that costs: with a hundred accounts online, each
   * tick blocked the bus for a hundred database reads, the relay fell behind,
   * and within a minute the newest price on the serving instance was fourteen
   * seconds old. The engine then — correctly — refused every order with
   * `STALE_QUOTE`. The platform was right about the price it had. The price it
   * had was late because of *this*.
   *
   * So valuation is decoupled from ingestion. The tick path records a symbol in
   * a set; `drain` does the work on its own cadence. The failure mode that
   * remains is the right one: under load the *frames* thin out while the
   * *prices* stay current, rather than the other way round.
   */
  onTick(tick: Tick): void {
    const pending = this.dirtySymbols.get(tick.symbol);
    if (pending === undefined || tick.timestamp < pending) {
      this.dirtySymbols.set(tick.symbol, tick.timestamp);
    }
  }

  /**
   * Value the accounts exposed to whatever has moved since the last pass.
   *
   * Exposed so tests can drive it without waiting for the loop. Everything that
   * can be slow lives here: the exposure index's own rebuild, the valuations,
   * the frames.
   */
  async drain(nowMs: number = Date.now()): Promise<void> {
    const symbols = [...this.dirtySymbols.keys()];
    if (symbols.length === 0) {
      this.dirtySymbols.clear();
      return;
    }
    /**
     * The oldest tick this pass is answering for. Every frame it produces is
     * measured against this rather than against the newest price, so a pass
     * that has been waiting on a slow database reports the delay it caused
     * instead of the microsecond since the last tick arrived.
     */
    const oldestTickAt = Math.min(...this.dirtySymbols.values());
    this.dirtySymbols.clear();

    /**
     * Grouped by tenant, and this loop runs on a timer rather than in a request.
     *
     * That distinction is the whole reason the grouping exists. A timer has no
     * tenant in scope, so every query made from here is refused — correctly:
     * the scope guard cannot tell a background loop from a handler that forgot
     * to open a scope, and it must assume the worse of the two. The loop does
     * genuinely serve more than one tenant, because it serves whoever is
     * connected to this instance.
     *
     * So it opens each tenant's scope in turn rather than bypassing tenancy.
     * A bypass would have been one line and would have made this the one place
     * on the platform where a cross-tenant read is routine.
     */
    const groups = this.gateway.tenantsOfListeners([WsChannel.ACCOUNT, WsChannel.PNL]);
    if (groups.length === 0) return;

    const interval = this.config.getOrThrow('REALTIME_VALUATION_INTERVAL_MS', { infer: true });

    /**
     * Which accounts are due, from memory rather than a query.
     *
     * The exposure index answers "who holds this instrument" without a round
     * trip; it is a routing hint and never an input to money, which is what
     * makes holding it in memory safe. See ExposureIndex.
     */
    const due = new Map<string, TenantContext>();
    for (const { tenant, accounts } of groups) {
      if (accounts.size === 0) continue;
      for (const symbol of symbols) {
        const exposed = await withTenant(tenant, () =>
          this.exposure.exposedTo(symbol, accounts, nowMs),
        );
        for (const accountId of exposed) {
          if (nowMs - (this.lastValuedAt.get(accountId) ?? 0) < interval) continue;
          // A valuation already running means the previous pass is still serving
          // this account; skipping is correct, since the next pass is newer.
          if (this.inFlight.has(accountId)) continue;
          due.set(accountId, tenant);
        }
      }
    }
    if (due.size === 0) return;

    /**
     * Valued a few at a time.
     *
     * Serially, a hundred accounts is a hundred round trips end to end and the
     * pass takes longer than the interval it is meant to run at. All at once,
     * a busy platform opens a hundred simultaneous connections to price screens
     * nobody is waiting on, competing with the orders that *are* being waited
     * on. A small window uses the I/O wait without becoming the load.
     */
    /**
     * Oldest first, and only as many as the budget allows.
     *
     * The queue is ordered by when each account was last valued, so an account
     * deferred by one pass is at the front of the next. Workers stop taking
     * from it once the pass has used `REALTIME_VALUATION_BUDGET_MS` of the
     * loop; what is left is counted and waits. `lastValuedAt` is stamped when
     * a valuation actually starts, not when it is queued, so a deferred
     * account stays due.
     */
    const budgetMs = this.config.getOrThrow('REALTIME_VALUATION_BUDGET_MS', { infer: true });
    const passStartedAt = Date.now();
    const queue = [...due].sort(
      ([a], [b]) => (this.lastValuedAt.get(a) ?? 0) - (this.lastValuedAt.get(b) ?? 0),
    );

    const workers = Array.from({ length: Math.min(VALUATION_CONCURRENCY, queue.length) }, () =>
      (async () => {
        for (;;) {
          if (Date.now() - passStartedAt > budgetMs) return;
          const next = queue.shift();
          if (next === undefined) return;
          const [accountId, tenant] = next;
          this.lastValuedAt.set(accountId, nowMs);
          this.inFlight.add(accountId);
          try {
            // The valuation reads positions and writes a frame for one account.
            // It runs in that account's tenant, exactly as a request would.
            await withTenant(tenant, () => this.pushValuation(accountId, oldestTickAt));
          } catch (error) {
            this.logger.error({ err: error, accountId }, 'Realtime valuation failed');
          } finally {
            this.inFlight.delete(accountId);
          }
        }
      })(),
    );
    await Promise.all(workers);
    if (queue.length > 0) this.metrics.realtimeDeferred.inc(queue.length);
  }

  /**
   * A self-rescheduling timeout, not an interval.
   *
   * An interval queues its callback behind a slow pass and then fires them back
   * to back, so a database stall would be followed by a burst of valuations all
   * reading the same rows. Rescheduling after the work finishes cannot do that,
   * which is the property that makes the decoupling worth having: a pass that
   * takes longer than its cadence delays the next pass and nothing else.
   */
  private scheduleDrain(): void {
    const interval = this.config.getOrThrow('REALTIME_VALUATION_INTERVAL_MS', { infer: true });
    const delay = Math.max(50, Math.min(interval === 0 ? 50 : interval, 1_000));

    const dueAt = Date.now() + delay;
    this.drainTimer = setTimeout(() => {
      /**
       * How late this pass is starting. `setTimeout` fires when the event loop
       * gets to it, so this is the loop's own back-pressure — a number no
       * per-query timing can show, because every query in a late pass can be
       * fast and the pass still be a second behind.
       */
      this.metrics.realtimePassLag.observe(Math.max(0, Date.now() - dueAt) / 1000);
      void this.drain()
        .catch((error: unknown) => {
          this.logger.error({ err: error }, 'Realtime valuation pass failed');
        })
        .finally(() => {
          this.drainTimer = null;
          if (!this.stopped) this.scheduleDrain();
        });
    }, delay);
    this.drainTimer.unref?.();
  }

  private async pushValuation(accountId: string, sinceTickAt?: number): Promise<void> {
    const valuation = await this.accountState.valuate(accountId);
    if (sinceTickAt !== undefined) {
      this.metrics.tickToPnl.observe(Math.max(0, Date.now() - sinceTickAt) / 1000);
    }

    this.gateway.sendToAccount(
      accountId,
      WsChannel.ACCOUNT,
      'account.updated',
      this.accountState.toDto(valuation),
    );

    /**
     * One frame for the whole book, not one per position.
     *
     * At a thousand traders holding thirteen positions each, a frame per
     * position was thirteen frames per socket per valuation — 92 frames a
     * second on each of five thousand sockets, and the serving instance spent
     * itself on serialisation while orders waited. The figures were always
     * computed together, from one valuation at one price; sending them
     * together is also the honest shape: a screen never shows position A at
     * one moment and position B at another.
     */
    if (valuation.positions.length > 0) {
      this.gateway.sendToAccount(
        accountId,
        WsChannel.PNL,
        'pnl.updated',
        valuation.positions.map(
          (position) =>
            ({
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
            }) satisfies PnlUpdatePayload,
        ),
      );
    }

    /**
     * Observed after the frames are handed to the sockets, before the risk
     * announcement — which is throttled to transitions and would make the
     * measurement depend on whether anything changed.
     */
    if (sinceTickAt !== undefined) {
      this.metrics.tickToSocket.observe(Math.max(0, Date.now() - sinceTickAt) / 1000);
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
    } satisfies RiskUpdatePayload);

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
    this.inFlight.delete(accountId);
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
