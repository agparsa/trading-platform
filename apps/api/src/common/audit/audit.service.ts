import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PlatformEvent } from '@tp/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { requireTenantId } from '@tp/tenancy';
import { currentRequestScope } from '../request-scope';
import { SECURITY_KINDS, isPersonResource } from '../../security/security-kinds';

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
  // A push token is a bearer credential for delivering a message to somebody's
  // phone. `token` above does not catch it: the check is an exact match on the
  // lower-cased key, not a substring.
  'pushtoken',
  'devicetoken',
  'registrationtoken',
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
   * Never throws **when it writes on its own**. An audit failure must not roll
   * back the operation it was describing — the write already happened, and
   * losing the record of it is strictly better than losing the operation. The
   * failure is logged loudly.
   *
   * Pass `tx` and both halves of that reasoning invert. Inside a caller's
   * transaction the operation has *not* happened yet, so a failed audit rolls it
   * back, and the error propagates rather than being logged and dropped. That is
   * the right shape for a change whose whole meaning is the record — altering
   * what a role may do, say, where an unaudited change is indistinguishable from
   * an intruder's.
   */
  async record(entry: AuditRecord, tx?: Prisma.TransactionClient): Promise<void> {
    if (tx !== undefined) {
      await writeAudit(tx, entry);
      return;
    }
    try {
      await writeAudit(this.prisma, entry);
    } catch (error) {
      this.logger.error({ err: error, action: entry.action }, 'Failed to write audit record');
    }
  }
}

type AuditWriter = Pick<Prisma.TransactionClient, 'auditLog' | 'securityEvent' | 'outboxEvent'>;

/**
 * The severity at which a security event is also somebody's *alarm* (§49).
 *
 * The feed shows all three. A webhook is a different thing: it wakes a
 * receiver, and a receiver woken by every successful sign-in stops being read.
 * WARNING is the platform's own word for "this is what an attacker leaves
 * behind" — a failed sign-in, a new device, a second factor switched off, a
 * break-glass, an IP rule changed — and that is exactly the set a firm's SIEM
 * wants and the set a person should be interrupted for.
 *
 * Raising this to include NOTICE would be a product decision about noise, not
 * a code change: it is one entry in this set.
 */
const ALERTING_SEVERITIES = new Set<string>(['WARNING']);

/**
 * The audit row, and — when the action is somebody's security business — the
 * security event derived from it, in that order and on the same client. The
 * feed is a projection of the audit log, so a feed row without its audit row
 * is not a state that should exist.
 */
async function writeAudit(client: AuditWriter, entry: AuditRecord): Promise<void> {
  const tenantId = requireTenantId();
  const requestId = entry.requestId ?? currentRequestScope()?.requestId ?? null;
  const after =
    entry.after === undefined ? undefined : (redact(entry.after) as Prisma.InputJsonValue);
  const written = await client.auditLog.create({
    data: {
      tenantId,
      actorId: entry.actorId ?? null,
      actorType: entry.actorType,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      before:
        entry.before === undefined ? undefined : (redact(entry.before) as Prisma.InputJsonValue),
      after,
      requestId,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
    },
    select: { id: true },
  });

  const security = SECURITY_KINDS[entry.action];
  if (security === undefined) return;
  const subject =
    security.subject === 'resource' && isPersonResource(entry.resourceType)
      ? (entry.resourceId ?? null)
      : (entry.actorId ?? null);
  const event = await client.securityEvent.create({
    data: {
      tenantId,
      userId: subject,
      kind: security.kind,
      severity: security.severity,
      actorId: entry.actorId ?? null,
      actorType: entry.actorType,
      requestId,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
      details: after,
      auditLogId: written.id,
    },
    select: { id: true },
  });

  if (!ALERTING_SEVERITIES.has(security.severity)) return;

  /**
   * The same occurrence, once more, where a firm's own systems can be told
   * about it — on the same client as the audit row and the feed row, so a
   * rollback takes all three or none.
   *
   * The payload is identifiers plus the redacted `after` the feed already
   * shows. Nothing here is a secret: `redact` ran on the way in, and it is the
   * *only* reason `details` can be sent at all — the endpoint was registered by
   * an administrator of this firm and receives this firm's rows, but an audit
   * diff is still the last place a credential should be allowed to appear.
   */
  await client.outboxEvent.create({
    data: {
      tenantId,
      eventId: randomUUID(),
      eventType: PlatformEvent.SECURITY_ALERT,
      aggregateType: 'security_event',
      aggregateId: event.id,
      // A security event is about a person, not an account. Leaving this null
      // is what stops a receiver filtering by account from silently dropping
      // every alert it was registered to hear.
      accountId: null,
      actorId: entry.actorId ?? null,
      correlationId: requestId,
      causationId: null,
      payload: {
        securityEventId: event.id,
        auditLogId: written.id,
        kind: security.kind,
        severity: security.severity,
        action: entry.action,
        userId: subject,
        actorId: entry.actorId ?? null,
        actorType: entry.actorType,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
        requestId,
        details: after ?? null,
      } as Prisma.InputJsonValue,
    },
  });
}
