import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { withoutTenantScope } from '@tp/tenancy';
import { PrismaService } from '../prisma/prisma.service';
import { QuoteService } from '../market/quote.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { MetricsService } from './metrics.service';

/**
 * Keeps the gauges current.
 *
 * On a schedule, not on scrape. Prometheus scrapes every fifteen seconds and
 * every replica answers it; computing five `COUNT(*)`s inside the request would
 * put the dashboard's cost on the same connection pool the trading path uses,
 * at a rate set by however many people are watching. A gauge that is up to
 * `REFRESH_MS` old is a gauge nobody will misread — these are shapes, not
 * money.
 *
 * Nothing here is on any request path, and nothing it reads is authoritative
 * for anything: a failure updates no gauge and is logged.
 */
@Injectable()
export class PlatformMetricsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PlatformMetricsService.name);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly quotes: QuoteService,
    private readonly gateway: RealtimeGateway,
  ) {}

  onApplicationBootstrap(): void {
    this.stopped = false;
    // Once immediately, so a freshly started instance is not blank for a
    // quarter of a minute during exactly the deploy somebody is watching.
    void this.refresh().catch(() => undefined);
    this.schedule();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * A self-rescheduling timeout rather than an interval, so a slow pass delays
   * the next one instead of queueing a burst behind it.
   */
  private schedule(): void {
    this.timer = setTimeout(() => {
      void this.refresh()
        .catch((error: unknown) => {
          this.logger.warn({ err: error }, 'Platform metrics refresh failed');
        })
        .finally(() => {
          this.timer = null;
          if (!this.stopped) this.schedule();
        });
    }, REFRESH_MS);
    this.timer.unref?.();
  }

  /** Exposed so a test can drive one pass without waiting for the schedule. */
  async refresh(): Promise<void> {
    /**
     * Counted across every tenant, deliberately, and named as such.
     *
     * These gauges are for whoever operates the *platform* — how many accounts
     * exist, how many positions are open, how many findings are unresolved. A
     * figure scoped to one tenant would answer a question nobody asked of
     * `/metrics`, which is restricted to private ranges precisely because it
     * describes the whole deployment.
     *
     * They are counts and never rows, so nothing crosses from one firm to
     * another; and the bypass carries its reason, so a reviewer grepping for
     * every crossing of the boundary finds this one with its argument attached.
     * It runs on a timer, where there is no tenant to be in scope at all.
     */
    const [accounts, openPositions, findings, signals] = await withoutTenantScope(
      'platform-wide gauges count every tenant; they are counts, never rows',
      () =>
        Promise.all([
          this.prisma.account.groupBy({ by: ['status'], _count: { _all: true } }),
          this.prisma.position.count({ where: { status: { in: ['OPEN', 'CLOSING'] } } }),
          this.prisma.reconciliationFinding.groupBy({
            by: ['severity'],
            where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING'] } },
            _count: { _all: true },
          }),
          this.prisma.integritySignal.groupBy({
            by: ['severity'],
            where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING'] } },
            _count: { _all: true },
          }),
        ]),
    );

    /**
     * Reset before setting.
     *
     * A gauge left at its last value is worse than one that is missing: the last
     * account in `SUSPENDED` being reinstated would leave the dashboard showing
     * one for ever, and somebody would go looking for it.
     */
    this.metrics.accounts.reset();
    for (const row of accounts) this.metrics.accounts.set({ status: row.status }, row._count._all);

    this.metrics.openPositions.set(openPositions);

    this.metrics.openFindings.reset();
    for (const row of findings) {
      this.metrics.openFindings.set({ severity: row.severity }, row._count._all);
    }

    this.metrics.openSignals.reset();
    for (const row of signals) {
      this.metrics.openSignals.set({ severity: row.severity }, row._count._all);
    }

    const sockets = this.gateway.socketCounts();
    this.metrics.connectedSockets.set({ state: 'authenticated' }, sockets.authenticated);
    this.metrics.connectedSockets.set({ state: 'anonymous' }, sockets.anonymous);

    /**
     * `-1` when no tick has ever arrived, because a gauge has no way to say
     * "never" and zero would read as "perfectly fresh" — the opposite of the
     * truth, and the reading somebody would page on.
     */
    this.metrics.marketFeedAge.set(this.quotes.newestTickAge() ?? -1);
  }
}

/**
 * How often the gauges are recomputed.
 *
 * Matched to a typical scrape interval. Faster buys nothing — Prometheus would
 * not see it — and costs a handful of aggregate queries against the same
 * database the trading path uses.
 */
const REFRESH_MS = 15_000;
