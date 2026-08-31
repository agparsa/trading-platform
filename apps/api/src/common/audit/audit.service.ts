import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { requireTenantId } from '../../tenancy/tenant-context';

export type AuditActorType = 'USER' | 'ADMIN' | 'SYSTEM';

export interface AuditRecord {
  readonly actorId?: string | null;
  readonly actorType: AuditActorType;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly before?: Prisma.InputJsonValue;
  readonly after?: Prisma.InputJsonValue;
  readonly requestId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

/** Field names that must never reach the audit table, at any nesting depth. */
const REDACTED_KEYS = new Set([
  'password',
  'currentpassword',
  'newpassword',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'tokenhash',
  'totpsecret',
  'totpcode',
  'secret',
  'authorization',
  // Invitations are identified in the audit trail by fingerprint. If a raw code
  // ever reaches an audit payload it is a mistake, and this catches it.
  'invitecode',
  'codehash',
]);

/**
 * Strips secrets from an audit payload.
 *
 * The audit log is the one table designed to be read by humans investigating an
 * incident, which makes it the worst place to leak a credential. Redaction is
 * applied recursively, on the way in, rather than trusted to call sites.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(entry, depth + 1);
  }
  return output;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes an audit row.
   *
   * Never throws. An audit failure must not roll back the operation it was
   * describing — the write already happened, and losing the record of it is
   * strictly better than losing the operation. The failure is logged loudly.
   */
  async record(entry: AuditRecord): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId: requireTenantId(),
          actorId: entry.actorId ?? null,
          actorType: entry.actorType,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          before:
            entry.before === undefined
              ? undefined
              : (redact(entry.before) as Prisma.InputJsonValue),
          after:
            entry.after === undefined ? undefined : (redact(entry.after) as Prisma.InputJsonValue),
          requestId: entry.requestId ?? null,
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent ?? null,
        },
      });
    } catch (error) {
      this.logger.error({ err: error, action: entry.action }, 'Failed to write audit record');
    }
  }
}
