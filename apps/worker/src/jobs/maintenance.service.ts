import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { withoutTenantScope } from '@tp/tenancy';

/**
 * Housekeeping that keeps unbounded tables from becoming unbounded.
 *
 * Idempotency keys exist to make a retry safe for as long as a client might
 * plausibly retry. Past their TTL they are dead weight on an indexed table that
 * every order write touches.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  async sweepIdempotencyKeys(now: Date = new Date()): Promise<number> {
    /**
     * Expiry is a property of the row, not of whose firm wrote it.
     *
     * Sweeping per tenant would mean a tenant with no scheduled sweep keeps its
     * expired keys forever, and the table grows without bound for reasons
     * nobody would connect to tenancy.
     */
    const result = await withoutTenantScope('housekeeping expires keys for every tenant', () =>
      this.prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } }),
    );
    if (result.count > 0) {
      this.logger.log(`Swept ${result.count} expired idempotency key(s)`);
    }
    return result.count;
  }

  /**
   * Releases keys left claimed by a process that died mid-request.
   *
   * Without this, an order that crashed the API between claiming its key and
   * completing would leave that key permanently unusable — the client would get
   * "already in flight" forever. One hour is far longer than any request should
   * live and far shorter than the key's own TTL.
   */
  async releaseAbandonedClaims(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - 3_600_000);
    const result = await withoutTenantScope(
      'an abandoned claim blocks its own tenant whichever one it belongs to',
      () =>
        this.prisma.idempotencyKey.deleteMany({
          where: { status: 'IN_PROGRESS', createdAt: { lt: cutoff } },
        }),
    );
    if (result.count > 0) {
      this.logger.warn(
        `Released ${result.count} idempotency claim(s) abandoned by a process that did not finish`,
      );
    }
    return result.count;
  }

  /**
   * Closes payments nobody ever paid.
   *
   * A bank transfer intent sits in `REQUIRES_ACTION` from the moment it is
   * started, and most of them are never paid — someone changed their mind, or
   * opened the page twice. Left alone they accumulate forever and every
   * operator screen showing "awaiting payment" fills with noise, which is how a
   * real awaiting-payment gets missed.
   *
   * Two things this deliberately does not do. It does not touch a payment in a
   * terminal state, so money that arrived is never un-arrived by a clock. And
   * it does not touch `PROCESSING`: the provider has the money in hand and is
   * still working, and expiring that would tell a payer their payment failed
   * while it was in fact about to succeed. Only the states where nothing has
   * moved can be closed by a timer.
   */
  async expireStalePayments(now: Date = new Date()): Promise<number> {
    const result = await withoutTenantScope(
      'a payment expires on its own clock whichever firm started it',
      () =>
        this.prisma.paymentIntent.updateMany({
          where: {
            status: { in: ['REQUIRES_ACTION'] },
            expiresAt: { lt: now },
          },
          data: { status: 'EXPIRED', failureReason: 'Not paid before the payment window closed' },
        }),
    );
    if (result.count > 0) {
      this.logger.log(`Expired ${result.count} unpaid payment(s)`);
    }
    return result.count;
  }
}
