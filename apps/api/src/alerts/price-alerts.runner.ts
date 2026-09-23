import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TickWindow, type Tick } from '@tp/market-core';
import { withTenant, withoutTenantScope } from '@tp/tenancy';
import { PrismaService } from '../prisma/prisma.service';
import { TickBus } from '../market/tick-bus';
import { LeadershipService, LeaderLoop } from '../leadership/leadership.service';
import { PriceAlertsService } from './price-alerts.service';
import { TenantResolver } from '../tenancy/tenant-resolver.service';
import type { Env } from '../config/env.schema';

/**
 * Watches the market on behalf of everyone who asked to be told something.
 *
 * ## Its own lease, not the trigger engine's
 *
 * Both watch prices, and they are deliberately not the same loop. A stop-loss
 * that fires twice closes a position the trader still holds, so the engine
 * stops entirely rather than risk it. An alert that arrives twice is a
 * duplicate notification. Sharing a lease would tie the second to the first's
 * caution — no alerts at all during any incident that costs the engine its
 * lease — for no gain, since the two do not conflict with each other.
 *
 * ## Off the tick path
 *
 * The tick handler folds prices into a window and returns. `TickBus` awaits its
 * handlers in order, so a database read here would be back-pressure on the feed
 * itself — the mistake the realtime valuation loop was built to undo, and there
 * is no reason to make it again for something less urgent.
 */
@Injectable()
export class PriceAlertsRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PriceAlertsRunner.name);
  private readonly window = new TickWindow();
  private readonly dirty = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly ticks: TickBus,
    private readonly alerts: PriceAlertsService,
    private readonly leadership: LeadershipService,
    private readonly tenants: TenantResolver,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.getOrThrow('PRICE_ALERTS_ENABLED', { infer: true })) {
      this.logger.warn('Price alerts are disabled on this instance');
      return;
    }
    /**
     * Subscribing happens whatever the lease says, and only *acting* is gated.
     *
     * A successor that starts with an empty window would decide the first tick
     * it sees against no range at all, and a level the market gapped through
     * during the handover would be missed silently. Keeping the window warm on
     * every eligible instance costs a map of six numbers per instrument.
     */
    this.unsubscribe = this.ticks.subscribe((tick) => {
      this.onTick(tick);
    });
    this.leadership.campaign(LeaderLoop.PRICE_ALERTS, {
      onAcquired: () => this.schedule(),
      onLost: () => this.unschedule(),
    });
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    this.unschedule();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Records the price and returns. Nothing slow may happen here. */
  onTick(tick: Tick): void {
    this.window.observe(tick);
    this.dirty.add(tick.symbol);
  }

  /**
   * One pass over the instruments that have moved.
   *
   * Exposed so tests can drive it without a timer.
   */
  async sweep(nowMs: number = Date.now()): Promise<number> {
    if (!this.leadership.isLeading(LeaderLoop.PRICE_ALERTS)) return 0;

    const symbols = [...this.dirty];
    this.dirty.clear();
    let fired = 0;

    for (const symbol of symbols) {
      const window = this.window.drain(symbol);
      if (window === null) continue;

      /**
       * The alerts on this instrument, across every firm, in one query — then
       * each one decided inside its own tenant.
       *
       * A per-tenant loop would be one query per firm per instrument per pass;
       * with sixteen firms and forty instruments that is six hundred round
       * trips a second to find, most of the time, nothing. The crossing is
       * named rather than hidden, which is the platform's rule for the few
       * places a background loop genuinely serves everybody.
       */
      const alerts = await withoutTenantScope(
        'the price alert sweep serves every tenant that is watching this instrument',
        () =>
          this.prisma.priceAlert.findMany({
            where: { symbol, status: 'ACTIVE' },
            take: MAX_ALERTS_PER_PASS,
          }),
      );

      for (const alert of alerts) {
        /**
         * The tenant is resolved rather than fabricated from the id on the row.
         * `TenantContext.slug` is what every log line and error message about
         * this work will carry, and a context invented here would put a firm's
         * alert in the logs under no name at all.
         */
        const tenant = await this.tenants.byId(alert.tenantId);
        if (tenant === null) {
          this.logger.error({ alertId: alert.id }, 'Price alert names a tenant that is gone');
          continue;
        }
        try {
          const triggered = await withTenant(tenant, () =>
            this.alerts.evaluate(alert, window, window.latest, nowMs),
          );
          if (triggered) fired += 1;
        } catch (error) {
          // One trader's alert must not stop everybody else's.
          this.logger.error({ err: error, alertId: alert.id }, 'Price alert evaluation failed');
        }
      }
    }
    return fired;
  }

  private schedule(): void {
    if (this.timer !== null || this.stopped) return;
    const interval = this.config.getOrThrow('PRICE_ALERT_SWEEP_INTERVAL_MS', { infer: true });
    const run = (): void => {
      this.timer = setTimeout(
        () => {
          void this.sweep()
            .catch((error: unknown) => {
              this.logger.error({ err: error }, 'Price alert sweep failed');
            })
            .finally(() => {
              this.timer = null;
              if (!this.stopped && this.leadership.isLeading(LeaderLoop.PRICE_ALERTS)) run();
            });
        },
        Math.max(100, interval),
      );
      this.timer.unref?.();
    };
    run();
    this.logger.log('Price alerts are being evaluated on this instance');
  }

  private unschedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * A ceiling on one pass, so a runaway table cannot become a stalled sweep.
 *
 * Above this the excess is simply read by the next pass — alerts are not
 * ordered relative to each other, so there is nothing to be unfair about.
 */
const MAX_ALERTS_PER_PASS = 5_000;
