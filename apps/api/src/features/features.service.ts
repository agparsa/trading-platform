import { Injectable, Logger } from '@nestjs/common';
import {
  DomainError,
  FEATURES,
  FEATURE_BY_KEY,
  TradingErrorCode,
  type Feature,
  type FeatureDefinition,
} from '@tp/shared-types';
import { currentTenant, requireTenantId, withTenant, type TenantContext } from '@tp/tenancy';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';

export interface FeatureState extends FeatureDefinition {
  readonly enabled: boolean;
  /** Whether a row overrides the default, and what it said. */
  readonly override: { readonly note: string; readonly updatedAt: Date } | null;
}

/** How long one firm's flags are believed before being read again. */
const CACHE_MS = 5_000;

/**
 * What is switched on for a firm (§95).
 *
 * ## Read on the order path, so cached
 *
 * `isEnabled` is asked inside order handling — is this account's venue
 * execution allowed, may this position trail — and a query per check would
 * add to a path that already makes too many. Each firm's overrides are held
 * for five seconds; a write invalidates this instance at once and the others
 * catch up within the window. A flag is a switch a person throws, not a
 * value that races.
 *
 * ## Who may write which flag
 *
 * The catalogue says. A `PLATFORM` flag is written by the platform, for a
 * broker, by entering that broker's scope — never by reaching across from the
 * platform's own; a `FIRM` flag is written by the firm for itself. The check
 * is here, in the service, and the controller only decides which route to
 * expose to whom.
 */
@Injectable()
export class FeaturesService {
  private readonly logger = new Logger(FeaturesService.name);
  private readonly cache = new Map<string, { at: number; overrides: Map<string, boolean> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Every flag with its effective value, for the firm in scope. */
  async list(): Promise<FeatureState[]> {
    const rows = await this.prisma.tenantFeature.findMany({
      select: { key: true, enabled: true, note: true, updatedAt: true },
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return FEATURES.map((definition) => {
      const row = byKey.get(definition.key);
      return {
        ...definition,
        enabled: row?.enabled ?? definition.default,
        override: row === undefined ? null : { note: row.note, updatedAt: row.updatedAt },
      };
    });
  }

  /** The effective flags as a client reads them: key → on/off. */
  async effective(): Promise<Record<Feature, boolean>> {
    const overrides = await this.overrides();
    return Object.fromEntries(
      FEATURES.map((definition) => [
        definition.key,
        overrides.get(definition.key) ?? definition.default,
      ]),
    ) as Record<Feature, boolean>;
  }

  async isEnabled(key: Feature): Promise<boolean> {
    const overrides = await this.overrides();
    return overrides.get(key) ?? FEATURE_BY_KEY[key].default;
  }

  /** Refuses, with a code a client can act on, when the flag is off. */
  async assertEnabled(key: Feature): Promise<void> {
    if (await this.isEnabled(key)) return;
    throw new DomainError(
      TradingErrorCode.FEATURE_DISABLED,
      `${FEATURE_BY_KEY[key].name} is not switched on for this firm`,
      { feature: key },
    );
  }

  /**
   * Set a flag for the firm in scope. `actorAuthority` is what the caller is
   * — the platform acting on a broker, or a firm acting on itself — and it
   * must match the flag's.
   */
  async set(args: {
    readonly actorId: string;
    readonly actorAuthority: 'PLATFORM' | 'FIRM';
    readonly key: Feature;
    readonly enabled: boolean;
    readonly note: string;
  }): Promise<FeatureState> {
    const definition = FEATURE_BY_KEY[args.key];
    if (definition.authority !== args.actorAuthority) {
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        definition.authority === 'PLATFORM'
          ? `${definition.name} is switched on by the platform, not by the firm`
          : `${definition.name} is the firm's own choice; the platform does not set it`,
        { feature: args.key, authority: definition.authority },
      );
    }
    const tenantId = requireTenantId();
    const before = await this.isEnabled(args.key);
    const row = await this.prisma.tenantFeature.upsert({
      where: { tenantId_key: { tenantId, key: args.key } },
      create: {
        tenantId,
        key: args.key,
        enabled: args.enabled,
        authority: definition.authority,
        note: args.note.trim(),
        updatedByUserId: args.actorId,
      },
      update: { enabled: args.enabled, note: args.note.trim(), updatedByUserId: args.actorId },
      select: { note: true, updatedAt: true },
    });
    this.cache.delete(tenantId);

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: args.actorId,
      action: args.enabled ? 'FEATURE_ENABLED' : 'FEATURE_DISABLED',
      resourceType: 'TenantFeature',
      resourceId: args.key,
      before: { enabled: before },
      after: { enabled: args.enabled, note: args.note.trim(), authority: definition.authority },
    });
    this.logger.warn(
      { tenantId, feature: args.key, enabled: args.enabled, by: args.actorAuthority },
      `Feature ${args.key} switched ${args.enabled ? 'on' : 'off'}`,
    );
    return { ...definition, enabled: args.enabled, override: row };
  }

  /**
   * The platform, acting on one broker. Enters that broker's scope so the row
   * is written as the broker's own, under its own isolation policy.
   */
  async setForBroker(
    actorId: string,
    broker: TenantContext,
    key: Feature,
    enabled: boolean,
    note: string,
  ): Promise<FeatureState> {
    const here = currentTenant();
    if (here === undefined || here.kind !== 'PLATFORM') {
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        'A broker’s platform flags are set from the platform, not from a broker.',
      );
    }
    return withTenant(broker, () =>
      this.set({ actorId, actorAuthority: 'PLATFORM', key, enabled, note }),
    );
  }

  /** The platform reading one broker's flags, the same way it sets them. */
  async listForBroker(broker: TenantContext): Promise<FeatureState[]> {
    const here = currentTenant();
    if (here === undefined || here.kind !== 'PLATFORM') {
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        'A broker’s flags are read from the platform, not from another broker.',
      );
    }
    return withTenant(broker, () => this.list());
  }

  private async overrides(): Promise<Map<string, boolean>> {
    const tenantId = requireTenantId();
    const cached = this.cache.get(tenantId);
    if (cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached.overrides;
    const rows = await this.prisma.tenantFeature.findMany({ select: { key: true, enabled: true } });
    const overrides = new Map(rows.map((row) => [row.key, row.enabled]));
    this.cache.set(tenantId, { at: Date.now(), overrides });
    return overrides;
  }
}
