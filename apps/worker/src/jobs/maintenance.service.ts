import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

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
    const result = await this.prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: now } },
    });
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
    const result = await this.prisma.idempotencyKey.deleteMany({
      where: { status: 'IN_PROGRESS', createdAt: { lt: cutoff } },
    });
    if (result.count > 0) {
      this.logger.warn(
        `Released ${result.count} idempotency claim(s) abandoned by a process that did not finish`,
      );
    }
    return result.count;
  }
}
