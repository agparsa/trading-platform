import { Injectable } from '@nestjs/common';
import type { Prisma, SecurityEventKind, SecuritySeverity } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Reads the security feed. Nothing here writes: rows arrive through
 * `AuditService`, derived from the audit trail, and the table refuses
 * UPDATE, DELETE and TRUNCATE.
 */
@Injectable()
export class SecurityEventsService {
  constructor(private readonly prisma: PrismaService) {}

  /** A person's own feed: what happened to their account, newest first. */
  async listMine(
    userId: string,
    options: { readonly limit?: number | undefined; readonly before?: Date | undefined } = {},
  ): Promise<readonly SecurityEventView[]> {
    const rows = await this.prisma.securityEvent.findMany({
      where: {
        userId,
        ...(options.before === undefined ? {} : { createdAt: { lt: options.before } }),
      },
      orderBy: { createdAt: 'desc' },
      take: clamp(options.limit, 50, 200),
    });
    return rows.map((row) => toView(row, userId));
  }

  /** The firm's feed, for whoever holds `security.read`. Bounded, always. */
  async listAll(filter: SecurityFeedFilter = {}): Promise<readonly AdminSecurityEventView[]> {
    const where: Prisma.SecurityEventWhereInput = {
      ...(filter.userId === undefined ? {} : { userId: filter.userId }),
      ...(filter.kind === undefined ? {} : { kind: filter.kind }),
      ...(filter.severity === undefined ? {} : { severity: filter.severity }),
      ...(filter.since === undefined ? {} : { createdAt: { gte: filter.since } }),
      ...(filter.ipAddress === undefined ? {} : { ipAddress: filter.ipAddress }),
    };
    const rows = await this.prisma.securityEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: clamp(filter.limit, 100, 500),
      include: { user: { select: { email: true, displayName: true } } },
    });
    return rows.map((row) => ({
      ...toView(row, row.userId),
      userId: row.userId,
      userEmail: row.user?.email ?? null,
      userDisplayName: row.user?.displayName ?? null,
      actorId: row.actorId,
      actorType: row.actorType,
      auditLogId: row.auditLogId,
    }));
  }

  /** The vocabulary the admin filter offers, so the UI does not hard-code it. */
  async summary(since: Date): Promise<SecurityFeedSummary> {
    const grouped = await this.prisma.securityEvent.groupBy({
      by: ['kind', 'severity'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });
    return {
      since,
      byKind: grouped.map((row) => ({
        kind: row.kind,
        severity: row.severity,
        count: row._count._all,
      })),
    };
  }
}

export interface SecurityFeedFilter {
  readonly userId?: string | undefined;
  readonly kind?: SecurityEventKind | undefined;
  readonly severity?: SecuritySeverity | undefined;
  readonly since?: Date | undefined;
  readonly ipAddress?: string | undefined;
  readonly limit?: number | undefined;
}

export interface SecurityEventView {
  readonly id: string;
  readonly kind: SecurityEventKind;
  readonly severity: SecuritySeverity;
  readonly at: Date;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  /** True when somebody other than the person did it — staff, or the platform. */
  readonly byOther: boolean;
  readonly details: Prisma.JsonValue | null;
}

export interface AdminSecurityEventView extends SecurityEventView {
  readonly userId: string | null;
  readonly userEmail: string | null;
  readonly userDisplayName: string | null;
  readonly actorId: string | null;
  readonly actorType: string;
  readonly auditLogId: string | null;
}

export interface SecurityFeedSummary {
  readonly since: Date;
  readonly byKind: readonly {
    readonly kind: SecurityEventKind;
    readonly severity: SecuritySeverity;
    readonly count: number;
  }[];
}

function toView(
  row: {
    id: string;
    kind: SecurityEventKind;
    severity: SecuritySeverity;
    createdAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
    requestId: string | null;
    actorId: string | null;
    details: Prisma.JsonValue | null;
  },
  subject: string | null,
): SecurityEventView {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    at: row.createdAt,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    requestId: row.requestId,
    byOther: row.actorId !== null && row.actorId !== subject,
    details: row.details,
  };
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}
