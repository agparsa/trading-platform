import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { credentialMatches, mintCredential, parseCredential } from '@tp/crypto-core';
import {
  DomainError,
  Permission,
  SERVICE_GRANTABLE_PERMISSIONS,
  TradingErrorCode,
  isKeyable,
  isPermission,
  isServiceGrantable,
  type UserRole,
} from '@tp/shared-types';
import { requireTenantId, withTenant, type TenantContext } from '@tp/tenancy';
import { PasswordService } from '../auth/password.service';
import { AuditService } from '../common/audit/audit.service';
import type { Env } from '../config/env.schema';
import { NotificationsService } from '../notifications/notifications.service';
import { RolesService } from '../permissions/roles.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * API keys and service tokens: bearer credentials that are not sessions.
 *
 * The rule, from the specification and without exception: never store the raw
 * secret; hash it; store a fingerprint for identification; show the generated
 * secret exactly once. `@tp/crypto-core`'s `mintCredential` is the only place
 * a secret exists in the clear, and `mint*` below hands it back once and
 * forgets it. Nothing in this service, the database, a log line or an audit
 * row can reproduce it. A holder who has lost one mints another.
 *
 * ## Two kinds, two rules
 *
 * An **API key** is a person's. It acts as them — the request carries their
 * id, their audit rows name them — within a subset of their capabilities
 * fixed at minting and intersected with their *current* ones on every use, so
 * a demotion reaches every key the person holds without anybody revoking
 * them. What may be in the subset is `KEYABLE_PERMISSIONS`: everything a
 * person may hold except the acts that must be a person's — money in, money
 * out, roles, identity documents, and keys themselves.
 *
 * A **service token** is the firm's. It carries only reads across the tenant
 * — `SERVICE_GRANTABLE_PERMISSIONS` — because every write on this platform is
 * audited against a person and the audit log has no way yet to name a
 * machine. It may carry only what its minter holds, so nobody mints a token
 * that can do more than they can.
 *
 * ## What every use costs
 *
 * One indexed read by fingerprint, one constant-time comparison, one read of
 * the holder, one Redis increment for the per-credential limit. Use is then
 * recorded off the request's path: a daily counter per credential, and the
 * credential's own last-used stamp at most once a minute.
 */
export type CredentialStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export interface UsageSummary {
  readonly requests: number;
  readonly refused: number;
  readonly throttled: number;
}

export interface ApiKeyView {
  readonly id: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly permissions: readonly Permission[];
  readonly rateLimitPerMinute: number;
  readonly status: CredentialStatus;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly lastUsedIp: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly createdAt: string;
  readonly usage7d: UsageSummary;
}

export interface AdminApiKeyView extends ApiKeyView {
  readonly userId: string;
  readonly email: string;
}

export interface ServiceTokenView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly fingerprint: string;
  readonly permissions: readonly Permission[];
  readonly rateLimitPerMinute: number;
  readonly status: CredentialStatus;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly lastUsedIp: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly usage7d: UsageSummary;
}

/** What a request carries once a credential has been accepted. */
export type CredentialPrincipal =
  | {
      readonly kind: 'api_key';
      readonly credentialId: string;
      readonly fingerprint: string;
      readonly user: { readonly id: string; readonly email: string; readonly role: UserRole };
      readonly permissions: ReadonlySet<Permission>;
    }
  | {
      readonly kind: 'service_token';
      readonly credentialId: string;
      readonly fingerprint: string;
      readonly permissions: ReadonlySet<Permission>;
    };

const NO_USAGE: UsageSummary = { requests: 0, refused: 0, throttled: 0 };
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

@Injectable()
export class CredentialsService implements OnModuleDestroy {
  private readonly logger = new Logger(CredentialsService.name);
  /** When each credential's last-used stamp was last written, so it is written once a minute. */
  private readonly lastUsedWrittenAt = new Map<string, number>();
  /**
   * Usage writes in flight. They are deliberately off the request's path, and
   * this is what lets a shutdown — or a test — wait for them rather than lose
   * them.
   */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    @Inject(RolesService) private readonly roles: RolesService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  /**
   * Turns a bearer string into a principal, or throws.
   *
   * Runs inside the request's tenant scope, so a key minted under another
   * tenant is simply not found — the same answer as a key that never existed,
   * which is the right amount to tell a caller.
   */
  async authenticate(
    bearer: string,
    tenant: TenantContext,
    ip: string | undefined,
  ): Promise<CredentialPrincipal> {
    const parsed = parseCredential(bearer);
    if (parsed === null) {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Invalid credential');
    }
    const now = new Date();

    if (parsed.kind === 'api_key') {
      const key = await this.prisma.apiKey.findUnique({
        where: { fingerprint: parsed.fingerprint },
        select: {
          id: true,
          tenantId: true,
          secretHash: true,
          permissions: true,
          rateLimitPerMinute: true,
          expiresAt: true,
          revokedAt: true,
          user: { select: { id: true, email: true, role: true, isActive: true } },
        },
      });
      if (
        key === null ||
        key.tenantId !== tenant.tenantId ||
        !credentialMatches(key.secretHash, parsed.secret)
      ) {
        throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Invalid credential');
      }
      this.assertLive(key, now, 'key');
      if (!key.user.isActive) {
        throw new DomainError(TradingErrorCode.FORBIDDEN, 'This account is disabled');
      }
      await this.throttle('API_KEY', key.id, key.rateLimitPerMinute, tenant, now);
      // The holder's *current* capabilities bound the key's, every time.
      const held = await this.roles.permissionsFor(key.user.role);
      const permissions = new Set(
        key.permissions.filter((p): p is Permission => isPermission(p) && held.has(p)),
      );
      this.noteUse('API_KEY', key.id, tenant, ip, now);
      return {
        kind: 'api_key',
        credentialId: key.id,
        fingerprint: parsed.fingerprint,
        user: { id: key.user.id, email: key.user.email, role: key.user.role },
        permissions,
      };
    }

    const token = await this.prisma.serviceToken.findUnique({
      where: { fingerprint: parsed.fingerprint },
      select: {
        id: true,
        tenantId: true,
        secretHash: true,
        permissions: true,
        rateLimitPerMinute: true,
        expiresAt: true,
        revokedAt: true,
      },
    });
    if (
      token === null ||
      token.tenantId !== tenant.tenantId ||
      !credentialMatches(token.secretHash, parsed.secret)
    ) {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Invalid credential');
    }
    this.assertLive(token, now, 'token');
    await this.throttle('SERVICE_TOKEN', token.id, token.rateLimitPerMinute, tenant, now);
    // Bounded by this build's list, not the one at minting: a capability that
    // stopped being grantable to machines stops being usable by them.
    const permissions = new Set<Permission>(token.permissions.filter(isServiceGrantable));
    this.noteUse('SERVICE_TOKEN', token.id, tenant, ip, now);
    return {
      kind: 'service_token',
      credentialId: token.id,
      fingerprint: parsed.fingerprint,
      permissions,
    };
  }

  /** Counted by the permission guard when a credential is refused a capability. */
  noteRefusal(
    kind: 'api_key' | 'service_token',
    credentialId: string,
    tenant: TenantContext,
  ): void {
    this.track(
      this.bumpUsage(
        kind === 'api_key' ? 'API_KEY' : 'SERVICE_TOKEN',
        credentialId,
        tenant,
        { refused: 1 },
        new Date(),
      ),
    );
  }

  /** Waits for every usage write started so far. */
  async drain(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  async onModuleDestroy(): Promise<void> {
    await this.drain();
  }

  private track(write: Promise<void>): void {
    this.inFlight.add(write);
    void write.finally(() => this.inFlight.delete(write));
  }

  private assertLive(
    row: { expiresAt: Date; revokedAt: Date | null },
    now: Date,
    noun: 'key' | 'token',
  ): void {
    if (row.revokedAt !== null) {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, `This ${noun} has been revoked`);
    }
    if (row.expiresAt.getTime() <= now.getTime()) {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, `This ${noun} has expired`);
    }
  }

  /**
   * A fixed window per credential per minute, in Redis.
   *
   * On top of the per-address limit, not instead of it: a key is a long-lived
   * secret in a script, and a script in a loop must not take the platform down
   * with a credential that is valid. If Redis cannot answer, the request is
   * allowed and the failure logged — the per-address limit still stands, and
   * refusing every valid client for a cache blip is the worse failure.
   */
  private async throttle(
    kind: 'API_KEY' | 'SERVICE_TOKEN',
    id: string,
    limit: number,
    tenant: TenantContext,
    now: Date,
  ): Promise<void> {
    const minute = Math.floor(now.getTime() / 60_000);
    const key = `credential:rl:${id}:${minute}`;
    let count: number;
    try {
      count = await this.redis.client.incr(key);
      if (count === 1) await this.redis.client.expire(key, 120);
    } catch (error) {
      this.logger.warn(
        { err: error, credentialId: id },
        'Per-credential rate limit unavailable; allowing',
      );
      return;
    }
    if (count > limit) {
      this.track(this.bumpUsage(kind, id, tenant, { throttled: 1 }, now));
      throw new DomainError(
        TradingErrorCode.RATE_LIMITED,
        `This credential may make ${limit} requests a minute`,
        { limit: String(limit) },
      );
    }
  }

  private noteUse(
    kind: 'API_KEY' | 'SERVICE_TOKEN',
    id: string,
    tenant: TenantContext,
    ip: string | undefined,
    now: Date,
  ): void {
    this.track(this.bumpUsage(kind, id, tenant, { requests: 1 }, now));
    const last = this.lastUsedWrittenAt.get(id) ?? 0;
    if (now.getTime() - last < LAST_USED_WRITE_INTERVAL_MS) return;
    this.lastUsedWrittenAt.set(id, now.getTime());
    this.track(
      withTenant(tenant, async () => {
        const data = { lastUsedAt: now, lastUsedIp: ip ?? null };
        if (kind === 'API_KEY') await this.prisma.apiKey.update({ where: { id }, data });
        else await this.prisma.serviceToken.update({ where: { id }, data });
      }).catch((error: unknown) => {
        this.logger.warn({ err: error, credentialId: id }, 'Could not stamp a credential as used');
      }),
    );
  }

  private async bumpUsage(
    kind: 'API_KEY' | 'SERVICE_TOKEN',
    id: string,
    tenant: TenantContext,
    delta: Partial<UsageSummary>,
    now: Date,
  ): Promise<void> {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const increments = {
      requests: { increment: delta.requests ?? 0 },
      refused: { increment: delta.refused ?? 0 },
      throttled: { increment: delta.throttled ?? 0 },
    };
    try {
      await withTenant(tenant, () =>
        this.prisma.credentialUsage.upsert({
          where: { kind_credentialId_day: { kind, credentialId: id, day } },
          create: {
            tenantId: tenant.tenantId,
            kind,
            credentialId: id,
            day,
            requests: delta.requests ?? 0,
            refused: delta.refused ?? 0,
            throttled: delta.throttled ?? 0,
          },
          update: increments,
        }),
      );
    } catch (error) {
      this.logger.warn({ err: error, credentialId: id }, 'Could not record credential usage');
    }
  }

  // ---------------------------------------------------------------------------
  // A person's keys
  // ---------------------------------------------------------------------------

  /**
   * Mint a key for the person themselves.
   *
   * Their password is asked for again, as it is for changing it: a session
   * that was left open on a shared screen must not be able to turn itself
   * into a secret that outlives it.
   */
  async mintApiKey(input: {
    readonly user: { id: string; role: UserRole };
    readonly name: string;
    readonly permissions: readonly string[];
    readonly expiresInDays?: number | undefined;
    readonly rateLimitPerMinute?: number | undefined;
    readonly password: string;
    readonly ip?: string | undefined;
  }): Promise<{ key: ApiKeyView; token: string }> {
    const holder = await this.prisma.user.findUnique({
      where: { id: input.user.id },
      select: { id: true, email: true, role: true, passwordHash: true, isActive: true },
    });
    if (holder === null || !holder.isActive) {
      throw new DomainError(TradingErrorCode.FORBIDDEN, 'This account is disabled');
    }
    if (!(await this.passwords.verify(holder.passwordHash, input.password))) {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Current password is incorrect');
    }

    const held = await this.roles.permissionsFor(holder.role);
    const permissions = this.grantable(input.permissions, held, {
      keyable: isKeyable,
      notKeyable: 'may not be carried by a key; it is an act a person makes',
      notHeld: 'is not something you can do, so a key of yours cannot either',
    });

    const maxLive = this.config.getOrThrow('API_KEY_MAX_PER_USER', { infer: true });
    const live = await this.prisma.apiKey.count({
      where: { userId: holder.id, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (live >= maxLive) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `You already hold ${live} live keys, which is the most allowed. Revoke one first.`,
        { max: String(maxLive) },
      );
    }

    const minted = mintCredential('api_key');
    const expiresAt = this.expiry(input.expiresInDays);
    const rateLimit = this.rateLimit(input.rateLimitPerMinute);

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.apiKey.create({
        data: {
          tenantId: requireTenantId(),
          userId: holder.id,
          name: input.name,
          fingerprint: minted.fingerprint,
          secretHash: minted.secretHash,
          permissions,
          rateLimitPerMinute: rateLimit,
          expiresAt,
          createdFromIp: input.ip ?? null,
        },
      });
      await this.audit.record(
        {
          actorId: holder.id,
          actorType: 'USER',
          action: 'api_key.minted',
          resourceType: 'ApiKey',
          resourceId: created.id,
          after: {
            fingerprint: minted.fingerprint,
            name: input.name,
            permissions,
            rateLimitPerMinute: rateLimit,
            expiresAt: expiresAt.toISOString(),
          },
          ipAddress: input.ip ?? null,
        },
        tx,
      );
      return created;
    });

    await this.notifications.raise({
      userId: holder.id,
      kind: 'api_key.minted',
      severity: 'INFO',
      title: 'An API key was created for your account',
      body: `"${input.name}" (${minted.fingerprint}) can ${describe(permissions)} until ${expiresAt.toISOString().slice(0, 10)}. If this was not you, revoke it now and change your password.`,
    });
    this.logger.log(`API key ${minted.fingerprint} minted for user ${holder.id}`);

    return { key: this.keyView(row, NO_USAGE), token: minted.token };
  }

  async listApiKeys(userId: string): Promise<readonly ApiKeyView[]> {
    const rows = await this.prisma.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    const usage = await this.usageFor(
      'API_KEY',
      rows.map((row) => row.id),
    );
    return rows.map((row) => this.keyView(row, usage.get(row.id) ?? NO_USAGE));
  }

  /** The holder ends their own key. */
  async revokeApiKey(input: {
    readonly userId: string;
    readonly id: string;
    readonly reason?: string | undefined;
  }): Promise<ApiKeyView> {
    const row = await this.prisma.apiKey.findFirst({
      where: { id: input.id, userId: input.userId },
    });
    if (row === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such key');
    }
    return this.endApiKey(row, {
      actorId: input.userId,
      actorType: 'USER',
      revokedById: null,
      reason: input.reason ?? 'Revoked by its holder',
    });
  }

  // ---------------------------------------------------------------------------
  // Every key, for staff
  // ---------------------------------------------------------------------------

  async listAllApiKeys(query: {
    search?: string;
    limit?: number;
  }): Promise<readonly AdminApiKeyView[]> {
    const search = query.search?.trim();
    const rows = await this.prisma.apiKey.findMany({
      where:
        search === undefined || search === ''
          ? {}
          : {
              OR: [
                { fingerprint: { contains: search } },
                { name: { contains: search, mode: 'insensitive' } },
                { user: { email: { contains: search, mode: 'insensitive' } } },
              ],
            },
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(query.limit ?? 100, 500),
    });
    const usage = await this.usageFor(
      'API_KEY',
      rows.map((row) => row.id),
    );
    return rows.map((row) => ({
      ...this.keyView(row, usage.get(row.id) ?? NO_USAGE),
      userId: row.userId,
      email: row.user.email,
    }));
  }

  /** Staff end anyone's key; the holder is told. */
  async revokeAnyApiKey(input: {
    readonly actorId: string;
    readonly id: string;
    readonly reason: string;
  }): Promise<AdminApiKeyView> {
    const row = await this.prisma.apiKey.findUnique({
      where: { id: input.id },
      include: { user: { select: { email: true } } },
    });
    if (row === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such key');
    }
    const view = await this.endApiKey(row, {
      actorId: input.actorId,
      actorType: 'ADMIN',
      revokedById: input.actorId,
      reason: input.reason,
    });
    await this.notifications.raise({
      userId: row.userId,
      kind: 'api_key.revoked',
      severity: 'WARNING',
      title: 'One of your API keys was revoked',
      body: `"${row.name}" (${row.fingerprint}) was revoked by the platform: ${input.reason}`,
    });
    return { ...view, userId: row.userId, email: row.user.email };
  }

  private async endApiKey(
    row: {
      id: string;
      userId: string;
      name: string;
      fingerprint: string;
      permissions: string[];
      rateLimitPerMinute: number;
      expiresAt: Date;
      lastUsedAt: Date | null;
      lastUsedIp: string | null;
      revokedAt: Date | null;
      revokedReason: string | null;
      createdAt: Date;
    },
    by: {
      actorId: string;
      actorType: 'USER' | 'ADMIN';
      revokedById: string | null;
      reason: string;
    },
  ): Promise<ApiKeyView> {
    if (row.revokedAt !== null) {
      throw new DomainError(
        TradingErrorCode.INVALID_STATE_TRANSITION,
        'This key is already revoked',
      );
    }
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.apiKey.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: now, revokedById: by.revokedById, revokedReason: by.reason },
      });
      if (result.count !== 1) {
        throw new DomainError(
          TradingErrorCode.INVALID_STATE_TRANSITION,
          'This key is already revoked',
        );
      }
      await this.audit.record(
        {
          actorId: by.actorId,
          actorType: by.actorType,
          action: 'api_key.revoked',
          resourceType: 'ApiKey',
          resourceId: row.id,
          before: { fingerprint: row.fingerprint, holderId: row.userId, status: 'ACTIVE' },
          after: { fingerprint: row.fingerprint, status: 'REVOKED', reason: by.reason },
        },
        tx,
      );
      return tx.apiKey.findUniqueOrThrow({ where: { id: row.id } });
    });
    this.logger.log(`API key ${row.fingerprint} revoked`);
    const usage = await this.usageFor('API_KEY', [row.id]);
    return this.keyView(updated, usage.get(row.id) ?? NO_USAGE);
  }

  // ---------------------------------------------------------------------------
  // Service tokens
  // ---------------------------------------------------------------------------

  async mintServiceToken(input: {
    readonly actor: { id: string; role: UserRole };
    readonly name: string;
    readonly description?: string | undefined;
    readonly permissions: readonly string[];
    readonly expiresInDays?: number | undefined;
    readonly rateLimitPerMinute?: number | undefined;
    readonly ip?: string | undefined;
  }): Promise<{ token: ServiceTokenView; secret: string }> {
    const held = await this.roles.permissionsFor(input.actor.role);
    const permissions = this.grantable(input.permissions, held, {
      keyable: isServiceGrantable,
      notKeyable: `may not be carried by a service token; a machine may read, and only ${SERVICE_GRANTABLE_PERMISSIONS.length} capabilities are reads across the tenant`,
      notHeld: 'is not something you hold, so a token you mint cannot either',
    });

    const minted = mintCredential('service_token');
    const expiresAt = this.expiry(input.expiresInDays);
    const rateLimit = this.rateLimit(input.rateLimitPerMinute);

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.serviceToken.create({
        data: {
          tenantId: requireTenantId(),
          name: input.name,
          description: input.description ?? null,
          fingerprint: minted.fingerprint,
          secretHash: minted.secretHash,
          permissions,
          rateLimitPerMinute: rateLimit,
          expiresAt,
          createdById: input.actor.id,
        },
        include: { createdBy: { select: { email: true } } },
      });
      await this.audit.record(
        {
          actorId: input.actor.id,
          actorType: 'ADMIN',
          action: 'service_token.minted',
          resourceType: 'ServiceToken',
          resourceId: created.id,
          after: {
            fingerprint: minted.fingerprint,
            name: input.name,
            permissions,
            rateLimitPerMinute: rateLimit,
            expiresAt: expiresAt.toISOString(),
          },
          ipAddress: input.ip ?? null,
        },
        tx,
      );
      return created;
    });
    this.logger.log(`Service token ${minted.fingerprint} minted by ${input.actor.id}`);
    return { token: this.tokenView(row, NO_USAGE), secret: minted.token };
  }

  async listServiceTokens(): Promise<readonly ServiceTokenView[]> {
    const rows = await this.prisma.serviceToken.findMany({
      include: { createdBy: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const usage = await this.usageFor(
      'SERVICE_TOKEN',
      rows.map((row) => row.id),
    );
    return rows.map((row) => this.tokenView(row, usage.get(row.id) ?? NO_USAGE));
  }

  async revokeServiceToken(input: {
    readonly actorId: string;
    readonly id: string;
    readonly reason: string;
  }): Promise<ServiceTokenView> {
    const row = await this.prisma.serviceToken.findUnique({ where: { id: input.id } });
    if (row === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such token');
    }
    if (row.revokedAt !== null) {
      throw new DomainError(
        TradingErrorCode.INVALID_STATE_TRANSITION,
        'This token is already revoked',
      );
    }
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.serviceToken.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: now, revokedById: input.actorId, revokedReason: input.reason },
      });
      if (result.count !== 1) {
        throw new DomainError(
          TradingErrorCode.INVALID_STATE_TRANSITION,
          'This token is already revoked',
        );
      }
      await this.audit.record(
        {
          actorId: input.actorId,
          actorType: 'ADMIN',
          action: 'service_token.revoked',
          resourceType: 'ServiceToken',
          resourceId: row.id,
          before: { fingerprint: row.fingerprint, status: 'ACTIVE' },
          after: { fingerprint: row.fingerprint, status: 'REVOKED', reason: input.reason },
        },
        tx,
      );
      return tx.serviceToken.findUniqueOrThrow({
        where: { id: row.id },
        include: { createdBy: { select: { email: true } } },
      });
    });
    this.logger.log(`Service token ${row.fingerprint} revoked`);
    const usage = await this.usageFor('SERVICE_TOKEN', [row.id]);
    return this.tokenView(updated, usage.get(row.id) ?? NO_USAGE);
  }

  // ---------------------------------------------------------------------------
  // Shared
  // ---------------------------------------------------------------------------

  /**
   * The permissions a credential may carry: named, known, allowed for its
   * kind, and held by the person minting it. Every refusal at once, so a
   * person is not sent round the loop once per entry.
   */
  private grantable(
    requested: readonly string[],
    held: ReadonlySet<Permission>,
    wording: {
      /** What this kind of credential may carry at all. */
      keyable: (value: string) => value is Permission;
      notKeyable: string;
      notHeld: string;
    },
  ): Permission[] {
    const unique = [...new Set(requested.map((p) => p.trim()))];
    if (unique.length === 0) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'A credential needs at least one capability',
      );
    }
    const problems: string[] = [];
    const permissions: Permission[] = [];
    for (const value of unique) {
      if (!isPermission(value)) problems.push(`"${value}" is not a capability this platform has`);
      else if (!wording.keyable(value)) problems.push(`${value} ${wording.notKeyable}`);
      else if (!held.has(value)) problems.push(`${value} ${wording.notHeld}`);
      else permissions.push(value);
    }
    if (problems.length > 0) {
      throw new DomainError(TradingErrorCode.VALIDATION_FAILED, problems.join('; '), {
        problems: problems.join('|'),
      });
    }
    return permissions;
  }

  private expiry(days: number | undefined): Date {
    const max = this.config.getOrThrow('API_KEY_MAX_TTL_DAYS', { infer: true });
    const chosen = days ?? this.config.getOrThrow('API_KEY_DEFAULT_TTL_DAYS', { infer: true });
    if (chosen < 1 || chosen > max) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `A credential lives between 1 and ${max} days`,
        { max: String(max) },
      );
    }
    return new Date(Date.now() + chosen * 86_400_000);
  }

  private rateLimit(requested: number | undefined): number {
    const ceiling = this.config.getOrThrow('API_KEY_RATE_LIMIT_PER_MINUTE', { infer: true });
    if (requested === undefined) return ceiling;
    if (requested < 1 || requested > ceiling) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `A credential's limit is between 1 and ${ceiling} requests a minute`,
        { max: String(ceiling) },
      );
    }
    return requested;
  }

  private async usageFor(
    kind: 'API_KEY' | 'SERVICE_TOKEN',
    ids: readonly string[],
  ): Promise<Map<string, UsageSummary>> {
    const summary = new Map<string, UsageSummary>();
    if (ids.length === 0) return summary;
    const since = new Date(Date.now() - 7 * 86_400_000);
    const rows = await this.prisma.credentialUsage.groupBy({
      by: ['credentialId'],
      where: { kind, credentialId: { in: [...ids] }, day: { gte: since } },
      _sum: { requests: true, refused: true, throttled: true },
    });
    for (const row of rows) {
      summary.set(row.credentialId, {
        requests: row._sum.requests ?? 0,
        refused: row._sum.refused ?? 0,
        throttled: row._sum.throttled ?? 0,
      });
    }
    return summary;
  }

  private keyView(
    row: {
      id: string;
      name: string;
      fingerprint: string;
      permissions: string[];
      rateLimitPerMinute: number;
      expiresAt: Date;
      lastUsedAt: Date | null;
      lastUsedIp: string | null;
      revokedAt: Date | null;
      revokedReason: string | null;
      createdAt: Date;
    },
    usage: UsageSummary,
  ): ApiKeyView {
    return {
      id: row.id,
      name: row.name,
      fingerprint: row.fingerprint,
      permissions: row.permissions.filter(isPermission),
      rateLimitPerMinute: row.rateLimitPerMinute,
      status: statusOf(row),
      expiresAt: row.expiresAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      lastUsedIp: row.lastUsedIp,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      revokedReason: row.revokedReason,
      createdAt: row.createdAt.toISOString(),
      usage7d: usage,
    };
  }

  private tokenView(
    row: {
      id: string;
      name: string;
      description: string | null;
      fingerprint: string;
      permissions: string[];
      rateLimitPerMinute: number;
      expiresAt: Date;
      lastUsedAt: Date | null;
      lastUsedIp: string | null;
      revokedAt: Date | null;
      revokedReason: string | null;
      createdAt: Date;
      createdBy: { email: string };
    },
    usage: UsageSummary,
  ): ServiceTokenView {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      fingerprint: row.fingerprint,
      permissions: row.permissions.filter(isPermission),
      rateLimitPerMinute: row.rateLimitPerMinute,
      status: statusOf(row),
      expiresAt: row.expiresAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      lastUsedIp: row.lastUsedIp,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      revokedReason: row.revokedReason,
      createdAt: row.createdAt.toISOString(),
      createdBy: row.createdBy.email,
      usage7d: usage,
    };
  }
}

function statusOf(row: { expiresAt: Date; revokedAt: Date | null }): CredentialStatus {
  if (row.revokedAt !== null) return 'REVOKED';
  if (row.expiresAt.getTime() <= Date.now()) return 'EXPIRED';
  return 'ACTIVE';
}

function describe(permissions: readonly Permission[]): string {
  return permissions.length <= 3
    ? permissions.join(', ')
    : `${permissions.slice(0, 3).join(', ')} and ${permissions.length - 3} more`;
}
