import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainEvent, DomainError, TradingErrorCode } from '@tp/shared-types';
import { requireTenantId } from '@tp/tenancy';
import { checkDestination, type DestinationRefusal } from '@tp/webhooks-core';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { SecretBoxService } from '../common/crypto/crypto.module';
import type { Env } from '../config/env.schema';

/** How long the previous secret keeps signing after a rotation. */
const ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;

const REFUSAL_WORDING: Record<DestinationRefusal, string> = {
  NOT_A_URL: 'is not a URL',
  NOT_HTTPS:
    'must be https:// — a signed event over plain HTTP is a signed event anybody on the path can read',
  HAS_CREDENTIALS:
    'must not carry a username or password; put authentication in the receiver, not the address',
  HAS_FRAGMENT: 'must not have a #fragment',
  LOCAL_NAME: 'names a local host, which this platform will not call',
  PRIVATE_ADDRESS:
    'is a private, loopback or link-local address, which this platform will not call',
};

/**
 * Where a firm's events are sent (§49).
 *
 * ## The secret is shown once
 *
 * A receiver verifies deliveries with a secret only it and this platform hold.
 * It is generated here, sealed under the platform's key list with the endpoint
 * id as context, and returned from `create` and `rotateSecret` and from nowhere
 * else. `list` shows the last four characters, so a receiver's configuration
 * can be matched to an endpoint without either side revealing the whole thing.
 *
 * ## Rotation does not drop anything
 *
 * A rotation keeps the previous secret for a day and every delivery in that
 * window is signed with both. The receiver switches at its own pace; a
 * delivery made the second before it switched still verifies.
 *
 * ## The destination is checked twice
 *
 * Here, when it is registered — https only, no credentials, no local names,
 * no private addresses. And again in the worker, at the moment of delivery,
 * against the address the name *then* resolves to, because a name that was
 * public when the form was filled in can point at 127.0.0.1 tomorrow.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBoxService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** The event types an endpoint may subscribe to: what the outbox carries. */
  eventTypes(): readonly string[] {
    return Object.values(DomainEvent);
  }

  async list() {
    return this.prisma.webhookEndpoint.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        url: true,
        description: true,
        events: true,
        enabled: true,
        disabledAt: true,
        disabledReason: true,
        consecutiveFailures: true,
        secretHint: true,
        previousSecretExpiresAt: true,
        createdAt: true,
        createdBy: { select: { id: true, email: true, displayName: true } },
      },
    });
  }

  async create(args: {
    readonly actorId: string;
    readonly url: string;
    readonly description: string;
    readonly events: readonly string[];
  }) {
    const url = this.acceptableUrl(args.url);
    const events = this.acceptableEvents(args.events);

    const secret = mintSecret();
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.webhookEndpoint.create({
        data: {
          tenantId: requireTenantId(),
          url,
          description: args.description.trim(),
          events: [...events],
          secretSealed: 'pending',
          secretHint: secret.slice(-4),
          createdByUserId: args.actorId,
        },
        select: { id: true },
      });
      // Sealed under the id, so a sealed value copied to another row will not open.
      return tx.webhookEndpoint.update({
        where: { id: row.id },
        data: { secretSealed: this.secrets.seal(secret, row.id) },
        select: {
          id: true,
          url: true,
          description: true,
          events: true,
          enabled: true,
          secretHint: true,
        },
      });
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: args.actorId,
      action: 'WEBHOOK_ENDPOINT_CREATED',
      resourceType: 'WebhookEndpoint',
      resourceId: created.id,
      after: { url, events, description: args.description.trim() },
    });
    this.logger.warn({ endpointId: created.id, url }, 'Webhook endpoint registered');
    return { endpoint: created, secret };
  }

  async setEnabled(args: {
    readonly actorId: string;
    readonly id: string;
    readonly enabled: boolean;
  }) {
    const existing = await this.requireEndpoint(args.id);
    await this.prisma.$transaction(async (tx) => {
      await tx.webhookEndpoint.update({
        where: { id: args.id },
        data: args.enabled
          ? { enabled: true, disabledAt: null, disabledReason: null, consecutiveFailures: 0 }
          : { enabled: false, disabledAt: new Date(), disabledReason: 'switched off by a person' },
      });
      if (args.enabled) {
        /**
         * Re-enabling re-schedules what was left when it was switched off:
         * deliveries the worker parked with no next attempt. They are owed
         * again, from the top of the schedule.
         */
        await tx.webhookDelivery.updateMany({
          where: { endpointId: args.id, status: 'FAILED', nextAttemptAt: null },
          data: { nextAttemptAt: new Date() },
        });
      }
    });
    await this.audit.record({
      actorType: 'ADMIN',
      actorId: args.actorId,
      action: args.enabled ? 'WEBHOOK_ENDPOINT_ENABLED' : 'WEBHOOK_ENDPOINT_DISABLED',
      resourceType: 'WebhookEndpoint',
      resourceId: args.id,
      after: { url: existing.url },
    });
    return { id: args.id, enabled: args.enabled };
  }

  async rotateSecret(args: { readonly actorId: string; readonly id: string }) {
    const existing = await this.requireEndpoint(args.id);
    const secret = mintSecret();
    await this.prisma.webhookEndpoint.update({
      where: { id: args.id },
      data: {
        secretSealed: this.secrets.seal(secret, args.id),
        secretHint: secret.slice(-4),
        previousSecretSealed: existing.secretSealed,
        previousSecretExpiresAt: new Date(Date.now() + ROTATION_OVERLAP_MS),
      },
    });
    await this.audit.record({
      actorType: 'ADMIN',
      actorId: args.actorId,
      action: 'WEBHOOK_SECRET_ROTATED',
      resourceType: 'WebhookEndpoint',
      resourceId: args.id,
      after: { url: existing.url, previousValidForMs: ROTATION_OVERLAP_MS },
    });
    return {
      id: args.id,
      secret,
      previousSecretValidUntil: new Date(Date.now() + ROTATION_OVERLAP_MS),
    };
  }

  async remove(actorId: string, id: string): Promise<void> {
    const existing = await this.requireEndpoint(id);
    // Deliveries cascade with the endpoint; the audit row is what remains.
    await this.prisma.webhookEndpoint.delete({ where: { id } });
    await this.audit.record({
      actorType: 'ADMIN',
      actorId,
      action: 'WEBHOOK_ENDPOINT_DELETED',
      resourceType: 'WebhookEndpoint',
      resourceId: id,
      before: { url: existing.url, events: existing.events },
    });
  }

  async deliveries(endpointId: string, limit: number) {
    await this.requireEndpoint(endpointId);
    return this.prisma.webhookDelivery.findMany({
      where: { endpointId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        eventId: true,
        eventType: true,
        status: true,
        attempts: true,
        nextAttemptAt: true,
        lastAttemptAt: true,
        deliveredAt: true,
        responseStatus: true,
        responseBody: true,
        lastError: true,
        durationMs: true,
        replayOfId: true,
        createdAt: true,
      },
    });
  }

  /**
   * Send an event again. A new row, pointing at the one it repeats, so the log
   * shows both what happened and that somebody asked for it to happen again.
   * Allowed whatever state the original is in — a receiver that lost a
   * delivered event needs it as much as one that never got it.
   */
  async replay(args: { readonly actorId: string; readonly deliveryId: string }) {
    const original = await this.prisma.webhookDelivery.findUnique({
      where: { id: args.deliveryId },
      select: {
        id: true,
        endpointId: true,
        outboxEventId: true,
        eventId: true,
        eventType: true,
        endpoint: { select: { enabled: true } },
      },
    });
    if (original === null)
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such delivery');
    if (!original.endpoint.enabled) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'This endpoint is switched off. Turn it on first; a replay to a disabled endpoint would sit undelivered.',
      );
    }
    const replay = await this.prisma.webhookDelivery.create({
      data: {
        tenantId: requireTenantId(),
        endpointId: original.endpointId,
        outboxEventId: original.outboxEventId,
        eventId: original.eventId,
        eventType: original.eventType,
        status: 'PENDING',
        nextAttemptAt: new Date(),
        replayOfId: original.id,
        requestedByUserId: args.actorId,
      },
      select: { id: true, eventId: true, status: true },
    });
    await this.audit.record({
      actorType: 'ADMIN',
      actorId: args.actorId,
      action: 'WEBHOOK_DELIVERY_REPLAYED',
      resourceType: 'WebhookDelivery',
      resourceId: replay.id,
      after: { replayOf: original.id, eventId: original.eventId, endpointId: original.endpointId },
    });
    return replay;
  }

  private acceptableUrl(raw: string): string {
    const allowHttp = this.config.get('WEBHOOK_ALLOW_HTTP', { infer: true }) === true;
    const checked = checkDestination(raw.trim(), { allowHttp });
    if (!checked.ok) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `That address ${REFUSAL_WORDING[checked.reason]}`,
        {
          reason: checked.reason,
        },
      );
    }
    return checked.url.toString();
  }

  private acceptableEvents(events: readonly string[]): readonly string[] {
    const known = new Set(this.eventTypes());
    const unknown = events.filter((event) => !known.has(event));
    if (unknown.length > 0) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `Unknown event type(s): ${unknown.join(', ')}`,
        {
          unknown: unknown.join(', '),
        },
      );
    }
    return [...new Set(events)].sort();
  }

  private async requireEndpoint(id: string) {
    const row = await this.prisma.webhookEndpoint.findUnique({ where: { id } });
    if (row === null)
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such webhook endpoint');
    return row;
  }
}

/** `whsec_` and 32 random bytes, base64url: 43 characters of entropy after the prefix. */
export function mintSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}
