import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env.schema';
import { withoutTenantScope, type TenantContext } from '@tp/tenancy';

/**
 * Which tenant a request belongs to, when nothing has authenticated yet.
 *
 * This is the **only** place a tenant is derived from something the client
 * controls, and it is limited to the hostname for exactly two reasons: a
 * hostname is chosen by DNS and TLS rather than by the request, and sign-in has
 * to know which firm's user table to look in before it can know anything else.
 *
 * Every authenticated request takes its tenant from the token instead. The
 * guard then checks the two agree — a token minted for one tenant and presented
 * on another's hostname is either an attack or a misconfiguration, and both are
 * worth refusing.
 */
@Injectable()
export class TenantResolver {
  private readonly logger = new Logger(TenantResolver.name);

  /**
   * Host → tenant, cached briefly.
   *
   * Every request would otherwise cost a lookup to answer a question whose
   * answer changes when somebody adds a tenant. Sixty seconds is short enough
   * that a new hostname works almost immediately and long enough that the
   * lookup is not on the hot path.
   */
  private readonly cache = new Map<string, { context: TenantContext; until: number }>();
  /** Separate from the host cache: the same tenant, asked for a different way. */
  private readonly byIdCache = new Map<string, { context: TenantContext; until: number }>();
  private static readonly TTL_MS = 60_000;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  /** Strips the port, lowercases, and refuses anything absurd. */
  static normaliseHost(raw: string | undefined): string {
    if (raw === undefined) return '';
    const host = raw.split(',')[0]?.trim().toLowerCase() ?? '';
    if (host.length === 0 || host.length > 253) return '';
    return host.replace(/:\d+$/, '');
  }

  async forHost(rawHost: string | undefined): Promise<TenantContext> {
    const host = TenantResolver.normaliseHost(rawHost);

    const cached = this.cache.get(host);
    if (cached !== undefined && cached.until > Date.now()) return cached.context;

    const byHost =
      host === ''
        ? null
        : await this.prisma.tenant.findUnique({
            where: { primaryHost: host },
            select: { id: true, slug: true, status: true },
          });

    const tenant = byHost ?? (await this.fallback(host));
    if (tenant.status !== 'ACTIVE') {
      /**
       * A suspended tenant is refused at the door rather than deeper in.
       *
       * Letting a request through and having each service check would mean the
       * check is only as good as its least careful call site, and the first
       * thing anybody forgets is the read paths.
       */
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        'This platform is not currently available.',
      );
    }

    const context: TenantContext = { tenantId: tenant.id, slug: tenant.slug };
    this.cache.set(host, { context, until: Date.now() + TenantResolver.TTL_MS });
    return context;
  }

  /**
   * The tenant a row belongs to, by id.
   *
   * For background work: a timer or a tick handler has no request and therefore
   * no tenant in scope, but the rows it finds each name one. Given that id this
   * returns the context to open, so the work runs inside a tenant exactly as a
   * request would rather than bypassing tenancy altogether.
   *
   * The lookup itself must cross the boundary — it is asking *which* tenant, so
   * it cannot already be inside one — and it reads the tenant's own row and
   * nothing belonging to it.
   *
   * A suspended tenant returns null rather than throwing. `forHost` throws
   * because a request must be refused; background work has nobody to refuse, and
   * the right behaviour is to skip that tenant's rows and carry on with the
   * others.
   */
  async byId(tenantId: string): Promise<TenantContext | null> {
    const cached = this.byIdCache.get(tenantId);
    if (cached !== undefined && cached.until > Date.now()) return cached.context;

    const tenant = await withoutTenantScope(
      'asking which tenant a row belongs to cannot itself be scoped to one',
      () =>
        this.prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { id: true, slug: true, status: true },
        }),
    );
    if (tenant === null || tenant.status !== 'ACTIVE') return null;

    const context: TenantContext = { tenantId: tenant.id, slug: tenant.slug };
    this.byIdCache.set(tenantId, { context, until: Date.now() + TenantResolver.TTL_MS });
    return context;
  }

  /**
   * What to do with a hostname no tenant claims.
   *
   * With one tenant this is every request, and falling back to it is what makes
   * a single-tenant deployment work with no configuration at all.
   *
   * With two tenants it is a hazard: a request for an unknown host would be
   * served somebody's data because they happened to be first in the table. So
   * `TENANT_HOST_STRICT=true` turns the fallback off, and the deployment
   * checklist turns it on the moment a second tenant exists.
   */
  private async fallback(host: string): Promise<{ id: string; slug: string; status: string }> {
    if (this.config.get('TENANT_HOST_STRICT', { infer: true })) {
      this.logger.warn({ host }, 'Refused a request for a hostname no tenant claims');
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Unknown host.');
    }

    const slug = this.config.get('TENANT_DEFAULT_SLUG', { infer: true });
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug },
      select: { id: true, slug: true, status: true },
    });
    if (tenant === null) {
      throw new Error(
        `TENANT_DEFAULT_SLUG is '${slug}' and no tenant has that slug. ` +
          'Run the seed, or set TENANT_HOST_STRICT=true and give every tenant a primaryHost.',
      );
    }
    return tenant;
  }

  /** Drops the cache. Called after a tenant is created or renamed. */
  forget(): void {
    this.cache.clear();
  }
}
