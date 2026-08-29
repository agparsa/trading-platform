import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Reading the audit trail.
 *
 * `audit.read` existed as a permission and guarded nothing — there was no route
 * to read the trail at all. An audit log that cannot be read is a log that
 * nobody checks, which is the same as not having one, except that it costs
 * storage and creates a false sense of coverage.
 *
 * ## Read-only, by construction
 *
 * There is no write path here, no update, no delete. §22 says the trail must be
 * immutable from the normal admin UI, and the way to achieve that is not a flag
 * — it is the absence of a method. The only writer in the platform is
 * `AuditService.record`.
 *
 * ## What comes back
 *
 * `before` and `after` are already redacted on the way *in* (see
 * `common/audit/redact.ts`); nothing here re-reads a secret because no secret
 * was ever written. The actor is joined by email so a reader does not have to
 * resolve a UUID by hand, which is the small friction that stops people looking.
 */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async search(query: {
    actorId?: string;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    sinceMs?: number;
    limit?: number;
  }): Promise<AuditRow[]> {
    const where: Prisma.AuditLogWhereInput = {};
    if (query.actorId !== undefined) where.actorId = query.actorId;
    // Prefix match, so `account.` finds every account action without the caller
    // having to know the full list. Anchored at the start: a substring search
    // over a growing table is a sequential scan waiting to happen.
    if (query.action !== undefined) where.action = { startsWith: query.action };
    if (query.resourceType !== undefined) where.resourceType = query.resourceType;
    if (query.resourceId !== undefined) where.resourceId = query.resourceId;
    if (query.sinceMs !== undefined) where.createdAt = { gte: new Date(query.sinceMs) };

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(query.limit ?? 100, 1), 500),
      select: {
        id: true,
        actorId: true,
        actorType: true,
        action: true,
        resourceType: true,
        resourceId: true,
        before: true,
        after: true,
        requestId: true,
        ipAddress: true,
        createdAt: true,
        actor: { select: { email: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      actorEmail: row.actor?.email ?? null,
      actorType: row.actorType,
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      before: row.before,
      after: row.after,
      requestId: row.requestId,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Which actions the trail actually contains.
   *
   * The filter above needs a vocabulary, and hard-coding one would go stale the
   * first time somebody added an action. Counted over the last thirty days so
   * the list reflects what the platform is doing now rather than everything it
   * has ever done.
   */
  async actions(nowMs = Date.now()): Promise<Array<{ action: string; count: number }>> {
    const since = new Date(nowMs - 30 * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.auditLog.groupBy({
      by: ['action'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      orderBy: { _count: { action: 'desc' } },
      take: 100,
    });
    return rows.map((row) => ({ action: row.action, count: row._count._all }));
  }
}

export interface AuditRow {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
  ipAddress: string | null;
  createdAt: string;
}
