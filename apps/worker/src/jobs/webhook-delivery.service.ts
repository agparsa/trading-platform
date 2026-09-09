import { Inject, Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OutboxEvent, Prisma, WebhookDelivery } from '@prisma/client';
import { SecretBox, parseEncryptionKeys } from '@tp/crypto-core';
import { requireTenantId, withTenant, withoutTenantScope } from '@tp/tenancy';
import {
  DEFAULT_RETRY,
  SIGNATURE_HEADER,
  delivered as isDelivered,
  nextDelayMs,
  shouldDisable,
  sign,
  type RetryPolicy,
} from '@tp/webhooks-core';
import { PrismaService } from '../prisma.service';
import type { WorkerEnv } from '../env';
import { OutboxRelayService, type OutboxDestination } from './outbox-relay.service';
import { sendOverHttp, type Sender } from './webhook-sender';

export interface DeliverySummary {
  readonly claimed: number;
  readonly delivered: number;
  readonly failed: number;
  readonly exhausted: number;
  readonly disabled: number;
}

/** What goes over the wire. The v2 envelope, minus the socket-only fields. */
export interface WebhookBody {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly accountId: string | null;
  readonly aggregate: { readonly type: string; readonly id: string };
  readonly data: unknown;
  /** Set on a replay, so a receiver can tell one from a first delivery. */
  readonly replay: boolean;
}

/**
 * Webhooks (§49): the outbox destination that *records* what is owed, and the
 * job that *pays* it.
 *
 * ## Two steps, on purpose
 *
 * The outbox relay hands an event to every destination and marks it RELAYED
 * once none of them threw. If this destination sent the HTTP request inside
 * that call, a slow receiver would hold up the relay for every other firm,
 * and a receiver that was down would make the *event* look undeliverable when
 * only one of its endpoints was. So `deliver()` only writes a delivery row per
 * subscribed endpoint — cheap, local, idempotent — and `deliverDue()` works
 * through those rows on its own schedule, each with its own retries.
 *
 * ## The claim is a lease
 *
 * A due row is claimed by pushing its `nextAttemptAt` two minutes out and
 * counting the attempt, in one `UPDATE … SKIP LOCKED`. If this process dies
 * mid-request the row comes due again in two minutes with the attempt already
 * counted, so a crash costs one retry and never a duplicate claim. Two workers
 * cannot claim the same row; the lock sees to that.
 *
 * ## What a failure does
 *
 * A non-2xx, a timeout, a refused address: the row goes to FAILED with the
 * next attempt scheduled by the retry policy, or to EXHAUSTED after the last
 * one. EXHAUSTED counts one consecutive failure against the endpoint, and at
 * the threshold the endpoint is switched off with a reason — because a
 * receiver nobody is running is not helped by another thousand attempts, and
 * the log they would fill hides the next real failure. Any success resets the
 * streak. Nothing is deleted.
 */
@Injectable()
export class WebhookDeliveryService implements OutboxDestination, OnModuleInit {
  readonly name = 'webhooks';
  private readonly logger = new Logger(WebhookDeliveryService.name);
  private box: SecretBox | null = null;
  private readonly policy: RetryPolicy;
  private readonly disableAfter: number;
  private readonly timeoutMs: number;
  private readonly batchSize: number;
  private readonly allowHttp: boolean;
  private readonly send: Sender;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config: ConfigService<WorkerEnv, true>,
    @Optional() private readonly relay?: OutboxRelayService,
    @Optional() secrets?: SecretBox,
    @Optional() sender?: Sender,
  ) {
    this.box = secrets ?? null;
    this.send = sender ?? sendOverHttp;
    this.policy = {
      ...DEFAULT_RETRY,
      maxAttempts: config.get('WEBHOOK_MAX_ATTEMPTS', { infer: true }) ?? DEFAULT_RETRY.maxAttempts,
    };
    this.disableAfter = config.get('WEBHOOK_DISABLE_AFTER_FAILURES', { infer: true }) ?? 5;
    this.timeoutMs = config.get('WEBHOOK_TIMEOUT_MS', { infer: true }) ?? 10_000;
    this.batchSize = config.get('WEBHOOK_BATCH_SIZE', { infer: true }) ?? 100;
    this.allowHttp = config.get('WEBHOOK_ALLOW_HTTP', { infer: true }) ?? false;
  }

  /** Registers with the relay, which is what makes an outbox event reach an endpoint at all. */
  onModuleInit(): void {
    this.relay?.register(this);
  }

  private secrets(): SecretBox | null {
    if (this.box !== null) return this.box;
    const keys = this.config.get('SECRET_ENCRYPTION_KEYS', { infer: true });
    if (keys === undefined || keys.length === 0) return null;
    this.box = new SecretBox(parseEncryptionKeys(keys));
    return this.box;
  }

  /**
   * The outbox destination. Runs inside the event's tenant scope, so the
   * endpoint query is that firm's alone. Writes the rows and returns; sends
   * nothing.
   */
  async deliver(event: OutboxEvent): Promise<void> {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { enabled: true },
      select: { id: true, events: true },
    });
    const subscribed = endpoints.filter(
      (endpoint) => endpoint.events.length === 0 || endpoint.events.includes(event.eventType),
    );
    if (subscribed.length === 0) return;

    /**
     * `skipDuplicates` against the partial unique index on
     * `(endpoint, outbox event) WHERE replay_of_id IS NULL`: the relay may hand
     * the same event over twice if it crashed between destinations, and the
     * second time must create nothing.
     */
    await this.prisma.webhookDelivery.createMany({
      data: subscribed.map((endpoint) => ({
        tenantId: requireTenantId(),
        endpointId: endpoint.id,
        outboxEventId: event.id,
        eventId: event.eventId,
        eventType: event.eventType,
        status: 'PENDING' as const,
        nextAttemptAt: new Date(),
      })),
      skipDuplicates: true,
    });
  }

  /** The scheduled job. Claims what is due, across every firm, and sends it. */
  async deliverDue(now: Date = new Date()): Promise<DeliverySummary> {
    const lease = new Date(now.getTime() + 2 * 60_000);
    const claimed = await withoutTenantScope(
      'deliveries are claimed across every firm; each is sent inside its own scope',
      () =>
        this.prisma.$queryRaw<
          Array<WebhookDelivery & { tenant_slug: string; tenant_kind: string }>
        >`
          WITH due AS (
            SELECT d.id
            FROM webhook_deliveries d
            WHERE d.status IN ('PENDING', 'FAILED')
              AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ${now})
            ORDER BY d.next_attempt_at NULLS FIRST, d.created_at
            LIMIT ${this.batchSize}
            FOR UPDATE SKIP LOCKED
          )
          UPDATE webhook_deliveries w
          SET next_attempt_at = ${lease}, attempts = w.attempts + 1, last_attempt_at = ${now}, updated_at = ${now}
          FROM due, tenants t
          WHERE w.id = due.id AND t.id = w.tenant_id
          RETURNING w.id, w.tenant_id AS "tenantId", w.endpoint_id AS "endpointId",
                    w.outbox_event_id AS "outboxEventId", w.event_id AS "eventId",
                    w.event_type AS "eventType", w.status, w.attempts,
                    w.replay_of_id AS "replayOfId", t.slug AS tenant_slug, t.kind AS tenant_kind
        `,
    );

    const summary = { claimed: claimed.length, delivered: 0, failed: 0, exhausted: 0, disabled: 0 };
    for (const row of claimed) {
      const outcome = await withTenant(
        { tenantId: row.tenantId, slug: row.tenant_slug, kind: row.tenant_kind as never },
        () => this.attempt(row, now),
      );
      if (outcome === 'DELIVERED') summary.delivered += 1;
      else if (outcome === 'FAILED') summary.failed += 1;
      else if (outcome === 'EXHAUSTED') summary.exhausted += 1;
      else if (outcome === 'DISABLED') {
        summary.exhausted += 1;
        summary.disabled += 1;
      }
    }
    if (summary.failed > 0 || summary.exhausted > 0) {
      this.logger.warn(summary, 'Webhook deliveries finished with failures');
    }
    return summary;
  }

  private async attempt(
    row: Pick<WebhookDelivery, 'id' | 'endpointId' | 'outboxEventId' | 'attempts' | 'replayOfId'>,
    now: Date,
  ): Promise<'DELIVERED' | 'FAILED' | 'EXHAUSTED' | 'DISABLED' | 'SKIPPED'> {
    const [endpoint, event] = await Promise.all([
      this.prisma.webhookEndpoint.findUnique({ where: { id: row.endpointId } }),
      this.prisma.outboxEvent.findUnique({ where: { id: row.outboxEventId } }),
    ]);
    if (endpoint === null || event === null) {
      await this.finish(row.id, {
        status: 'EXHAUSTED',
        lastError: 'endpoint or event no longer exists',
      });
      return 'EXHAUSTED';
    }
    if (!endpoint.enabled) {
      /**
       * Switched off between claim and send. Left FAILED with no next attempt:
       * turning the endpoint back on is what re-schedules it, and until then a
       * delivery to a disabled endpoint is not owed.
       */
      await this.finish(row.id, {
        status: 'FAILED',
        nextAttemptAt: null,
        lastError: 'endpoint is disabled',
      });
      return 'SKIPPED';
    }

    const box = this.secrets();
    if (box === null) {
      return this.failed(row, endpoint.id, now, {
        lastError: 'this worker cannot open sealed secrets (SECRET_ENCRYPTION_KEYS)',
      });
    }
    const secrets = [box.open(endpoint.secretSealed, endpoint.id)];
    if (
      endpoint.previousSecretSealed !== null &&
      endpoint.previousSecretExpiresAt !== null &&
      endpoint.previousSecretExpiresAt > now
    ) {
      secrets.push(box.open(endpoint.previousSecretSealed, endpoint.id));
    }

    const body: WebhookBody = {
      id: event.eventId,
      type: event.eventType,
      occurredAt: event.occurredAt.toISOString(),
      accountId: event.accountId,
      aggregate: { type: event.aggregateType, id: event.aggregateId },
      data: event.payload,
      replay: row.replayOfId !== null,
    };
    const raw = JSON.stringify(body);
    const timestamp = Math.floor(now.getTime() / 1000);

    const outcome = await this.send({
      url: endpoint.url,
      body: raw,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'trading-platform-webhooks/1',
        [SIGNATURE_HEADER]: sign(secrets, timestamp, raw),
        'x-event-id': event.eventId,
        'x-event-type': event.eventType,
        'x-delivery-id': row.id,
      },
      timeoutMs: this.timeoutMs,
      allowHttp: this.allowHttp,
    });

    if (outcome.kind === 'response' && isDelivered(outcome.status)) {
      await this.prisma.$transaction([
        this.prisma.webhookDelivery.update({
          where: { id: row.id },
          data: {
            status: 'DELIVERED',
            deliveredAt: now,
            nextAttemptAt: null,
            responseStatus: outcome.status,
            responseBody: outcome.body,
            lastError: null,
            durationMs: outcome.durationMs,
          },
        }),
        this.prisma.webhookEndpoint.update({
          where: { id: endpoint.id },
          data: { consecutiveFailures: 0 },
        }),
      ]);
      return 'DELIVERED';
    }

    return this.failed(row, endpoint.id, now, {
      responseStatus: outcome.kind === 'response' ? outcome.status : null,
      responseBody: outcome.kind === 'response' ? outcome.body : null,
      lastError:
        outcome.kind === 'response'
          ? `receiver answered ${outcome.status}`
          : outcome.reason.slice(0, 500),
      durationMs: outcome.durationMs,
    });
  }

  private async failed(
    row: Pick<WebhookDelivery, 'id' | 'attempts'>,
    endpointId: string,
    now: Date,
    detail: Pick<
      Prisma.WebhookDeliveryUpdateInput,
      'responseStatus' | 'responseBody' | 'lastError' | 'durationMs'
    >,
  ): Promise<'FAILED' | 'EXHAUSTED' | 'DISABLED'> {
    // `row.attempts` came back from the claim, which had already counted this one.
    const delay = nextDelayMs(row.attempts, this.policy);
    if (delay !== null) {
      await this.finish(row.id, {
        ...detail,
        status: 'FAILED',
        nextAttemptAt: new Date(now.getTime() + delay),
      });
      return 'FAILED';
    }

    await this.finish(row.id, { ...detail, status: 'EXHAUSTED', nextAttemptAt: null });
    const endpoint = await this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { consecutiveFailures: { increment: 1 } },
      select: { id: true, url: true, consecutiveFailures: true, enabled: true },
    });
    if (endpoint.enabled && shouldDisable(endpoint.consecutiveFailures, this.disableAfter)) {
      const reason = `switched off by the platform after ${endpoint.consecutiveFailures} deliveries in a row failed every attempt`;
      await this.prisma.webhookEndpoint.update({
        where: { id: endpoint.id },
        data: { enabled: false, disabledAt: now, disabledReason: reason },
      });
      await this.prisma.auditLog.create({
        data: {
          tenantId: requireTenantId(),
          actorType: 'SYSTEM',
          action: 'WEBHOOK_ENDPOINT_AUTO_DISABLED',
          resourceType: 'WebhookEndpoint',
          resourceId: endpoint.id,
          after: { url: endpoint.url, consecutiveFailures: endpoint.consecutiveFailures, reason },
        },
      });
      this.logger.error(
        { endpointId: endpoint.id, failures: endpoint.consecutiveFailures },
        'A webhook endpoint was switched off after repeated failed deliveries. A person needs to look.',
      );
      return 'DISABLED';
    }
    return 'EXHAUSTED';
  }

  private finish(id: string, data: Prisma.WebhookDeliveryUpdateInput): Promise<unknown> {
    return this.prisma.webhookDelivery.update({ where: { id }, data });
  }
}
