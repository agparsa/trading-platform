import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BrokerConnectionStatus, Prisma } from '@prisma/client';
import {
  BrokerAdapterError,
  BrokerAdapterRegistry,
  ConnectionMonitor,
  DEFAULT_MONITOR_OPTIONS,
  deserialiseCredentials,
  redactCredentialValues,
  type BrokerCapabilities,
  type BrokerCredentials,
} from '@tp/broker-sdk';
import { SecretBox, parseEncryptionKeys } from '@tp/crypto-core';
import { requireTenantId, withTenant, withoutTenantScope } from '@tp/tenancy';
import { PrismaService } from '../prisma.service';
import type { WorkerEnv } from '../env';

export interface BrokerHealthSummary {
  readonly checked: number;
  readonly connected: number;
  readonly degraded: number;
  readonly failing: number;
  /** Connections the breaker is holding off. Not checked this sweep, by design. */
  readonly backingOff: number;
}

/**
 * Asks every enabled connection how it is, and records the answer.
 *
 * ## Why the worker and not the API
 *
 * A health check is a call to somebody else's server. On a request path that
 * is a request that hangs; here it is a job that takes as long as it takes,
 * runs once whatever the number of API instances, and cannot be triggered by
 * a client at all.
 *
 * ## What it does not do
 *
 * It does not fail an account, mark a trade, or repair anything. A venue
 * being unreachable is a fact about the venue; the platform records it,
 * shows it, and — per §26 — never reads it as a trader having done
 * something. It also does not hammer: the `ConnectionMonitor`'s breaker is
 * restored from the row, and a connection inside its backoff window is
 * skipped rather than retried, with AUTH_FAILED held off longest because
 * retrying the same rejected credentials is how an account gets locked at
 * the venue.
 *
 * ## Tenancy
 *
 * Discovery crosses tenants deliberately — the sweep must find connections
 * belonging to every firm — and each connection is then handled *inside* its
 * own tenant's scope, so every read and write it does is scoped exactly as a
 * request would be.
 */
@Injectable()
export class BrokerHealthService {
  private readonly logger = new Logger(BrokerHealthService.name);
  private box: SecretBox | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: BrokerAdapterRegistry,
    @Inject(ConfigService) private readonly config: ConfigService<WorkerEnv, true>,
    secrets?: SecretBox,
  ) {
    this.box = secrets ?? null;
  }

  /**
   * The encryption keys, on first need rather than at construction.
   *
   * `SECRET_ENCRYPTION_KEYS` is optional for this process — a deployment with
   * push off and no venue connections does not need it — and a worker that
   * refused to boot without it would be a worse failure than the one it
   * prevents. So the absence is a fact about one connection, reported on that
   * connection, rather than a dead worker.
   */
  private secrets(): SecretBox | null {
    if (this.box !== null) return this.box;
    const keys = this.config.get('SECRET_ENCRYPTION_KEYS', { infer: true });
    if (keys === undefined || keys.length === 0) return null;
    this.box = new SecretBox(parseEncryptionKeys(keys));
    return this.box;
  }

  async sweep(now: Date = new Date()): Promise<BrokerHealthSummary> {
    const connections = await withoutTenantScope(
      'the health sweep must find every firm’s connections; each is then handled in its own scope',
      () =>
        this.prisma.brokerConnection.findMany({
          where: { enabled: true },
          select: {
            id: true,
            tenantId: true,
            tenant: { select: { slug: true, kind: true, status: true } },
          },
        }),
    );

    const summary = { checked: 0, connected: 0, degraded: 0, failing: 0, backingOff: 0 };
    for (const row of connections) {
      if (row.tenant.status !== 'ACTIVE') continue;
      try {
        const state = await withTenant(
          { tenantId: row.tenantId, slug: row.tenant.slug, kind: row.tenant.kind },
          () => this.checkOne(row.id, now),
        );
        if (state === 'SKIPPED') summary.backingOff += 1;
        else {
          summary.checked += 1;
          if (state === 'CONNECTED') summary.connected += 1;
          else if (state === 'DEGRADED') summary.degraded += 1;
          else summary.failing += 1;
        }
      } catch (error) {
        // One firm's connection must not stop the sweep for the others.
        this.logger.error(
          { err: error, connectionId: row.id, tenant: row.tenant.slug },
          'Health check failed outside the adapter; the connection was left as it was',
        );
      }
    }

    if (summary.failing > 0 || summary.degraded > 0) {
      this.logger.warn(summary, 'Broker connection health');
    }
    return summary;
  }

  /** One connection, inside its tenant. Returns the state it ended in. */
  async checkOne(connectionId: string, now: Date = new Date()): Promise<string> {
    const connection = await this.prisma.brokerConnection.findFirst({
      where: { id: connectionId },
      include: {
        credentials: {
          /**
           * `tenantId` named rather than inherited. The tenancy extension
           * narrows the top-level query; a relation reached through `include`
           * is filtered by its foreign key alone, so a credential row misfiled
           * under another firm would be opened for this one. Found by a test
           * that planted exactly that row. See docs/multi-tenancy.md §6.
           */
          where: { tenantId: requireTenantId(), revokedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
    if (connection === null) return 'SKIPPED';

    const monitor = ConnectionMonitor.restore(
      {
        consecutiveFailures: connection.consecutiveFailures,
        openings: connection.circuitOpenings,
        circuitOpenUntil: connection.circuitOpenUntil,
        lastHeartbeatAt: connection.lastHeartbeatAt,
        lastQuoteAt: connection.lastQuoteAt,
        lastOrderEventAt: connection.lastOrderEventAt,
        lastError: connection.lastError,
      },
      DEFAULT_MONITOR_OPTIONS,
    );
    if (!monitor.mayAttempt(now)) return 'SKIPPED';

    const credentialRow = connection.credentials[0];
    if (credentialRow === undefined) {
      monitor.failed('NOT_CONNECTED', 'no credentials have been set', now);
      await this.persist(connection, monitor, null, now);
      return monitor.snapshot().state;
    }

    const secrets = this.secrets();
    if (secrets === null) {
      this.logger.error(
        { connectionId },
        'This worker has no SECRET_ENCRYPTION_KEYS, so it cannot open a venue credential. ' +
          'Set the same keys the API seals with.',
      );
      monitor.failed('AUTH_FAILED', 'this worker cannot open sealed credentials', now);
      await this.persist(connection, monitor, null, now);
      return monitor.snapshot().state;
    }

    let credentials: BrokerCredentials;
    try {
      credentials = deserialiseCredentials(secrets.open(credentialRow.sealed, connection.id));
    } catch (error) {
      /**
       * The sealed blob will not open: a rotated encryption key, or a row
       * moved between connections. Recorded as a failure of this connection
       * and nothing else — and the message is ours, not the cipher's.
       */
      this.logger.error(
        { err: error, connectionId },
        'A broker credential could not be opened; the connection is unusable until it is set again',
      );
      monitor.failed('AUTH_FAILED', 'the stored credential could not be opened', now);
      await this.persist(connection, monitor, null, now);
      return monitor.snapshot().state;
    }

    const adapter = this.registry.has(connection.adapterKind)
      ? this.registry.create(connection.adapterKind, connection.settings as Record<string, unknown>)
      : null;
    if (adapter === null) {
      monitor.failed(
        'NOT_CONNECTED',
        `this build has no connector of kind ${connection.adapterKind}`,
        now,
      );
      await this.persist(connection, monitor, null, now);
      return monitor.snapshot().state;
    }

    let capabilities: BrokerCapabilities | null = null;
    try {
      await adapter.connect(credentials);
      capabilities = await adapter.getCapabilities();
      monitor.healthReported(await adapter.healthcheck(), new Date());
      await this.prisma.brokerCredential.update({
        where: { id: credentialRow.id },
        data: { lastUsedAt: new Date() },
      });
    } catch (error) {
      const wrapped =
        error instanceof BrokerAdapterError
          ? error
          : new BrokerAdapterError(
              'VENUE_ERROR',
              error instanceof Error ? error.message : String(error),
            );
      monitor.failed(
        wrapped.code,
        redactCredentialValues(wrapped.message, credentials),
        new Date(),
      );
    } finally {
      await adapter.disconnect().catch(() => undefined);
    }

    await this.persist(connection, monitor, capabilities, now);
    return monitor.snapshot().state;
  }

  private async persist(
    connection: { id: string; status: BrokerConnectionStatus; statusChangedAt: Date | null },
    monitor: ConnectionMonitor,
    capabilities: BrokerCapabilities | null,
    now: Date,
  ): Promise<void> {
    const snapshot = monitor.snapshot();
    const changed = snapshot.state !== connection.status;
    await this.prisma.brokerConnection.update({
      where: { id: connection.id },
      data: {
        status: snapshot.state as BrokerConnectionStatus,
        statusChangedAt: changed ? now : connection.statusChangedAt,
        ...(capabilities === null
          ? {}
          : { capabilities: capabilities as unknown as Prisma.InputJsonValue }),
        lastHeartbeatAt: snapshot.lastHeartbeatAt,
        lastQuoteAt: snapshot.lastQuoteAt,
        lastOrderEventAt: snapshot.lastOrderEventAt,
        latencyMs: snapshot.latencyMs,
        lastError: snapshot.lastError,
        consecutiveFailures: snapshot.consecutiveFailures,
        circuitOpenings: snapshot.openings,
        circuitOpenUntil: snapshot.circuitOpenUntil,
      },
    });
    if (changed) {
      this.logger.log(
        { connectionId: connection.id, from: connection.status, to: snapshot.state },
        'Broker connection state changed',
      );
    }
  }
}
