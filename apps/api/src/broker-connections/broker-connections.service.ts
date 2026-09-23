import { Injectable, Logger } from '@nestjs/common';
import type { BrokerConnectionStatus, Prisma } from '@prisma/client';
import {
  BrokerAdapterError,
  BrokerAdapterRegistry,
  ConnectionMonitor,
  DEFAULT_MONITOR_OPTIONS,
  credentialMetadata,
  deserialiseCredentials,
  redactCredentialValues,
  serialiseCredentials,
  type BrokerAdapter,
  type BrokerCapabilities,
  type BrokerCredentials,
} from '@tp/broker-sdk';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { requireTenantId } from '@tp/tenancy';
import { idSealContext } from '@tp/crypto-core';
import { AuditService } from '../common/audit/audit.service';
import { SecretBoxService } from '../common/crypto/crypto.module';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A firm's connections to venues: the rows, their credentials, and the one
 * place an adapter is built from them.
 *
 * ## What never leaves
 *
 * A credential's field values. They are sealed with `SecretBox`, bound to the
 * connection id as context, and opened only inside `withAdapter` — never
 * returned by a route, never put in an audit payload, never logged. What a
 * reader sees is the kind, the fingerprint and the fields the connector
 * declared non-secret. The sealed row is fixed at the database by trigger, so
 * a rotation is a new row and the old one revoked: who-used-what-when
 * survives.
 *
 * ## Why the adapter is built per use
 *
 * A connection is a row; an adapter is a live session. Holding one open per
 * connection for the life of the process is the shape the worker will need
 * (phase 3), and it is the wrong shape for an API request, which must not
 * inherit another request's half-broken session. So this service builds,
 * uses and disposes, and the monitor's verdict is persisted on the row where
 * the worker and the panel can both read it.
 */
@Injectable()
export class BrokerConnectionsService {
  private readonly logger = new Logger(BrokerConnectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly secrets: SecretBoxService,
    private readonly registry: BrokerAdapterRegistry,
  ) {}

  /** The connectors this build can make, for the panel's picker. */
  connectors(): readonly ConnectorView[] {
    return this.registry.kinds().map((factory) => ({
      kind: factory.kind,
      displayName: factory.displayName,
      documentation: factory.documentation,
      credentialFields: factory.credentialFields,
    }));
  }

  async list(): Promise<readonly ConnectionView[]> {
    const rows = await this.prisma.brokerConnection.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        credentials: {
          // Named, not inherited. The tenancy extension narrows the *top-level*
          // query; a relation reached through `include` is filtered by its
          // foreign key alone, so a row misfiled under another firm would come
          // back with this one. See docs/multi-tenancy.md §6.
          where: { tenantId: requireTenantId(), revokedAt: null },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    return rows.map(toView);
  }

  async get(id: string): Promise<ConnectionView> {
    const row = await this.prisma.brokerConnection.findFirst({
      where: { id },
      include: {
        credentials: { where: { tenantId: requireTenantId() }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (row === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such connection');
    }
    return toView(row);
  }

  async create(
    actorId: string,
    input: {
      readonly name: string;
      readonly adapterKind: string;
      readonly settings?: Record<string, unknown> | undefined;
    },
  ): Promise<ConnectionView> {
    if (!this.registry.has(input.adapterKind)) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `This build has no connector of kind ${input.adapterKind}. ` +
          `It knows: ${this.registry
            .kinds()
            .map((factory) => factory.kind)
            .join(', ')}.`,
        { adapterKind: input.adapterKind },
      );
    }
    const name = input.name.trim();
    const clash = await this.prisma.brokerConnection.findFirst({ where: { name } });
    if (clash !== null) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `A connection called '${name}' already exists.`,
      );
    }

    const created = await this.prisma.brokerConnection.create({
      data: {
        tenantId: requireTenantId(),
        name,
        adapterKind: input.adapterKind,
        settings: (input.settings ?? {}) as Prisma.InputJsonValue,
        createdById: actorId,
      },
      include: { credentials: true },
    });

    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'broker_connection.created',
      resourceType: 'broker_connection',
      resourceId: created.id,
      after: {
        name,
        adapterKind: input.adapterKind,
        settings: (input.settings ?? {}) as Prisma.InputJsonValue,
      },
    });
    return toView(created);
  }

  /**
   * Seal a set of credentials against this connection, revoking whatever it
   * was using. The values are never returned, never audited and never logged.
   */
  async setCredentials(
    actorId: string,
    connectionId: string,
    credentials: BrokerCredentials,
  ): Promise<ConnectionView> {
    const connection = await this.require(connectionId);
    const factory = this.registry.factory(connection.adapterKind);
    if (factory === undefined) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `This build has no connector of kind ${connection.adapterKind}.`,
      );
    }
    const wanted = new Set(factory.credentialFields.map((field) => field.key));
    const missing = [...wanted].filter((key) => (credentials.fields[key] ?? '').length === 0);
    if (missing.length > 0) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `${factory.displayName} needs: ${missing.join(', ')}.`,
        { missing: missing.join(',') },
      );
    }
    const unexpected = Object.keys(credentials.fields).filter((key) => !wanted.has(key));
    if (unexpected.length > 0) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `${factory.displayName} takes no field called ${unexpected.join(', ')}.`,
      );
    }

    const secretKeys = new Set(
      factory.credentialFields.filter((field) => field.secret).map((field) => field.key),
    );
    const metadata = credentialMetadata(credentials, secretKeys);
    const tenantId = requireTenantId();
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.brokerCredential.updateMany({
        where: { connectionId, revokedAt: null },
        data: { revokedAt: now, revokedById: actorId },
      });
      await tx.brokerCredential.create({
        data: {
          tenantId,
          connectionId,
          kind: credentials.kind,
          sealed: this.secrets.seal(serialiseCredentials(credentials), idSealContext(connectionId)),
          fingerprint: metadata.fingerprint,
          visible: metadata.visible as Prisma.InputJsonValue,
          createdById: actorId,
        },
      });
      /**
       * Inside the transaction: a credential set without a record of who set
       * it is indistinguishable from an intruder's, and there is no version
       * of this operation worth keeping without the record. The payload
       * carries the fingerprint and the non-secret fields only.
       */
      await this.audit.record(
        {
          actorId,
          actorType: 'ADMIN',
          action: 'broker_connection.credentials_set',
          resourceType: 'broker_connection',
          resourceId: connectionId,
          after: {
            kind: credentials.kind,
            fingerprint: metadata.fingerprint,
            visible: metadata.visible,
          },
        },
        tx,
      );
    });

    // A new credential is a new session; the old verdict describes the old one.
    await this.prisma.brokerConnection.update({
      where: { id: connectionId },
      data: { status: 'UNKNOWN', lastError: null, consecutiveFailures: 0, circuitOpenUntil: null },
    });
    return this.get(connectionId);
  }

  async setEnabled(
    actorId: string,
    id: string,
    enabled: boolean,
    reason: string,
  ): Promise<ConnectionView> {
    const before = await this.require(id);
    if (before.enabled === enabled) return this.get(id);
    await this.prisma.brokerConnection.update({ where: { id }, data: { enabled } });
    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: enabled ? 'broker_connection.enabled' : 'broker_connection.disabled',
      resourceType: 'broker_connection',
      resourceId: id,
      before: { enabled: before.enabled },
      after: { enabled, reason },
    });
    return this.get(id);
  }

  /**
   * Connect, ask what the venue can do, and record the verdict.
   *
   * The one place a person can make the platform talk to a venue on demand.
   * It is how "we set the credentials, does it work" is answered without
   * waiting for the worker's next sweep, and its result is the same monitor
   * verdict the worker would have produced.
   */
  async test(actorId: string, id: string): Promise<ConnectionTestResult> {
    const connection = await this.require(id);
    const monitor = ConnectionMonitor.restore(
      {
        consecutiveFailures: connection.consecutiveFailures,
        openings: connection.circuitOpenings,
        circuitOpenUntil: connection.circuitOpenUntil,
      },
      DEFAULT_MONITOR_OPTIONS,
    );
    const now = new Date();
    if (!monitor.mayAttempt(now)) {
      throw new DomainError(
        TradingErrorCode.RATE_LIMITED,
        'This connection is backing off after repeated failures. It will be retried automatically.',
        { until: connection.circuitOpenUntil?.toISOString() ?? '' },
      );
    }

    let capabilities: BrokerCapabilities | null = null;
    let failure: { code: string; message: string } | null = null;
    try {
      capabilities = await this.withAdapter(id, async (adapter) => {
        const found = await adapter.getCapabilities();
        monitor.healthReported(await adapter.healthcheck(), new Date());
        return found;
      });
    } catch (error) {
      /**
       * A `DomainError` here is the platform refusing — no credentials set,
       * the connection disabled — not the venue failing. It travels to the
       * caller as itself, and nothing is recorded against the connection:
       * "you have not finished setting this up" is not a venue outage, and
       * counting it as one would open the breaker on a connection that has
       * never been tried.
       */
      if (error instanceof DomainError) throw error;
      const wrapped =
        error instanceof BrokerAdapterError
          ? error
          : new BrokerAdapterError('VENUE_ERROR', messageOf(error));
      failure = { code: wrapped.code, message: wrapped.message };
      monitor.failed(wrapped.code, wrapped.message, new Date());
    }

    const snapshot = monitor.snapshot();
    await this.prisma.brokerConnection.update({
      where: { id },
      data: {
        status: snapshot.state as BrokerConnectionStatus,
        statusChangedAt:
          snapshot.state === connection.status ? connection.statusChangedAt : new Date(),
        ...(capabilities === null
          ? {}
          : { capabilities: capabilities as unknown as Prisma.InputJsonValue }),
        lastHeartbeatAt: snapshot.lastHeartbeatAt,
        latencyMs: snapshot.latencyMs,
        lastError: snapshot.lastError,
        consecutiveFailures: snapshot.consecutiveFailures,
        circuitOpenings: snapshot.openings,
        circuitOpenUntil: snapshot.circuitOpenUntil,
      },
    });

    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'broker_connection.tested',
      resourceType: 'broker_connection',
      resourceId: id,
      after: { status: snapshot.state, ...(failure === null ? {} : { failure: failure.code }) },
    });

    return { status: snapshot.state, capabilities, failure, at: new Date() };
  }

  /**
   * Build an adapter for this connection, run `use`, and dispose of it.
   *
   * The only place a sealed credential is opened. If `use` throws, any
   * credential value that leaked into the message is stripped before the
   * error travels on — connectors are told never to include one, and this is
   * what catches the one that does.
   */
  async withAdapter<T>(
    connectionId: string,
    use: (adapter: BrokerAdapter) => Promise<T>,
  ): Promise<T> {
    const connection = await this.require(connectionId);
    if (!connection.enabled) {
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        `The connection '${connection.name}' is disabled.`,
        { connectionId },
      );
    }
    const row = await this.prisma.brokerCredential.findFirst({
      where: { connectionId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (row === null) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `The connection '${connection.name}' has no credentials yet.`,
        { connectionId },
      );
    }
    const credentials = deserialiseCredentials(
      this.secrets.open(row.sealed, idSealContext(connectionId)),
    );
    const adapter = this.registry.create(
      connection.adapterKind,
      connection.settings as Record<string, unknown>,
    );
    try {
      await adapter.connect(credentials);
      const answer = await use(adapter);
      void this.stampUse(row.id).catch(() => undefined);
      return answer;
    } catch (error) {
      if (error instanceof BrokerAdapterError) {
        throw new BrokerAdapterError(
          error.code,
          redactCredentialValues(error.message, credentials),
          error.retryable,
        );
      }
      if (error instanceof Error) {
        error.message = redactCredentialValues(error.message, credentials);
      }
      throw error;
    } finally {
      await adapter.disconnect().catch((error: unknown) => {
        this.logger.warn({ err: error, connectionId }, 'Disconnecting the venue session failed');
      });
    }
  }

  private async stampUse(credentialId: string): Promise<void> {
    await this.prisma.brokerCredential.update({
      where: { id: credentialId },
      data: { lastUsedAt: new Date() },
    });
  }

  private async require(id: string) {
    const row = await this.prisma.brokerConnection.findFirst({ where: { id } });
    if (row === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such connection');
    }
    return row;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ConnectorView {
  readonly kind: string;
  readonly displayName: string;
  /** What the connector was written against. Empty for the mock. */
  readonly documentation: string;
  readonly credentialFields: readonly {
    readonly key: string;
    readonly label: string;
    readonly secret: boolean;
  }[];
}

export interface ConnectionView {
  readonly id: string;
  readonly name: string;
  readonly adapterKind: string;
  readonly settings: unknown;
  readonly enabled: boolean;
  readonly status: BrokerConnectionStatus;
  readonly capabilities: unknown;
  readonly lastHeartbeatAt: Date | null;
  readonly lastQuoteAt: Date | null;
  readonly lastOrderEventAt: Date | null;
  readonly latencyMs: number | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly circuitOpenUntil: Date | null;
  readonly statusChangedAt: Date | null;
  readonly createdAt: Date;
  /** Metadata only. There is no shape of this object that carries a secret. */
  readonly credentials: readonly {
    readonly id: string;
    readonly kind: string;
    readonly fingerprint: string;
    readonly visible: unknown;
    readonly createdAt: Date;
    readonly revokedAt: Date | null;
    readonly lastUsedAt: Date | null;
  }[];
}

export interface ConnectionTestResult {
  readonly status: string;
  readonly capabilities: BrokerCapabilities | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly at: Date;
}

function toView(row: {
  id: string;
  name: string;
  adapterKind: string;
  settings: unknown;
  enabled: boolean;
  status: BrokerConnectionStatus;
  capabilities: unknown;
  lastHeartbeatAt: Date | null;
  lastQuoteAt: Date | null;
  lastOrderEventAt: Date | null;
  latencyMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  circuitOpenUntil: Date | null;
  statusChangedAt: Date | null;
  createdAt: Date;
  credentials?: {
    id: string;
    kind: string;
    fingerprint: string;
    visible: unknown;
    createdAt: Date;
    revokedAt: Date | null;
    lastUsedAt: Date | null;
  }[];
}): ConnectionView {
  return {
    id: row.id,
    name: row.name,
    adapterKind: row.adapterKind,
    settings: row.settings,
    enabled: row.enabled,
    status: row.status,
    capabilities: row.capabilities,
    lastHeartbeatAt: row.lastHeartbeatAt,
    lastQuoteAt: row.lastQuoteAt,
    lastOrderEventAt: row.lastOrderEventAt,
    latencyMs: row.latencyMs,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    circuitOpenUntil: row.circuitOpenUntil,
    statusChangedAt: row.statusChangedAt,
    createdAt: row.createdAt,
    // `sealed` is deliberately absent from what this function can even see.
    credentials: (row.credentials ?? []).map((credential) => ({
      id: credential.id,
      kind: credential.kind,
      fingerprint: credential.fingerprint,
      visible: credential.visible,
      createdAt: credential.createdAt,
      revokedAt: credential.revokedAt,
      lastUsedAt: credential.lastUsedAt,
    })),
  };
}
