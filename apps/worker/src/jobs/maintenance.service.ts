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

  /**
   * Writes EXPIRED on verifications whose validity has run out.
   *
   * The gate does not wait for this — `KycService.isVerified` judges from the
   * policy to the minute — so this is housekeeping that makes the column agree
   * with the policy, and that lets the person see "expired" on their screen
   * rather than "verified" beside a withdrawal that refuses.
   */
  async expireVerifications(now: Date = new Date()): Promise<number> {
    const result = await withoutTenantScope(
      'a verification lapses on its own clock whichever firm granted it',
      () =>
        this.prisma.kycRecord.updateMany({
          where: { status: 'VERIFIED', expiresAt: { not: null, lt: now } },
          data: {
            status: 'EXPIRED',
            reason:
              'Your verification has lapsed under the platform’s validity period. Please verify again.',
          },
        }),
    );
    if (result.count > 0) {
      this.logger.log(`Expired ${result.count} identity verification(s)`);
    }
    return result.count;
  }

  /**
   * Clears the bytes of identity documents past their retention period.
   *
   * ## What "past" means
   *
   * The record must be *decided* — verified, rejected or expired — and the
   * decision must be older than the retention period. A record still waiting
   * for a reviewer keeps its documents however old it is: purging them would
   * make the review impossible, and the delay is the platform's, not the
   * person's.
   *
   * Only documents from the decided attempt go: one uploaded after the last
   * decision belongs to a new submission and stays.
   *
   * ## What stays
   *
   * The row. Kind, hash, size, upload time and now `purgedAt`. That a document
   * of this kind was seen on this date is a fact the record may have to stand
   * on for years after the bytes are gone; the trigger on the table makes sure
   * nothing but the bytes can change.
   */
  async purgeIdentityDocuments(retentionDays: number, now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    const due = await withoutTenantScope(
      'retention runs on every firm’s documents on the same clock',
      () =>
        this.prisma.kycDocument.findMany({
          where: {
            content: { not: null },
            record: {
              status: { in: ['VERIFIED', 'REJECTED', 'EXPIRED'] },
              decidedAt: { not: null, lt: cutoff },
            },
          },
          select: { id: true, record: { select: { decidedAt: true } }, uploadedAt: true },
        }),
    );

    const ids = due
      .filter((one) => one.record.decidedAt !== null && one.uploadedAt <= one.record.decidedAt)
      .map((one) => one.id);
    if (ids.length === 0) return 0;

    const result = await withoutTenantScope(
      'retention runs on every firm’s documents on the same clock',
      () =>
        this.prisma.kycDocument.updateMany({
          where: { id: { in: ids } },
          data: { content: null, purgedAt: now },
        }),
    );
    if (result.count > 0) {
      this.logger.log(
        `Purged the bytes of ${result.count} identity document(s) past ${retentionDays} days`,
      );
    }
    return result.count;
  }

  /**
   * Clears the bytes of reports past their expiry.
   *
   * The row stays, and keeps saying what was asked for, who asked, how many
   * rows came back and what the file hashed to. Only the file goes. A report is
   * evidence that an operator was shown a particular set of rows on a
   * particular day, and that fact is worth keeping long after the megabytes are
   * not — the same reasoning as `purgeIdentityDocuments` above, and the same
   * shape.
   *
   * `expiresAt` is written by the job that produced the file, so retention is
   * decided once, at production, rather than re-derived here from a setting
   * that may since have changed. A file promised for fourteen days keeps its
   * fourteen days.
   */
  async purgeExpiredReports(now: Date = new Date()): Promise<number> {
    const result = await withoutTenantScope(
      'retention runs on every firm’s reports on the same clock',
      () =>
        this.prisma.report.updateMany({
          where: { status: 'READY', content: { not: null }, expiresAt: { not: null, lt: now } },
          data: { status: 'EXPIRED', content: null, purgedAt: now },
        }),
    );
    if (result.count > 0) {
      this.logger.log(`Cleared the bytes of ${result.count} expired report(s)`);
    }
    return result.count;
  }
}
