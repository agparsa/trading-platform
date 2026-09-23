import { Injectable } from '@nestjs/common';
import type { Prisma, RiskLimitSet } from '@prisma/client';
import { toDecimal } from '@tp/financial-core';
import type { AccountRiskLimits } from '@tp/risk-core';
import { withoutTenantScope } from '@tp/tenancy';
import { PrismaService } from '../prisma/prisma.service';

/** The layers, outermost first. Order matters only for the explanation. */
export type RiskLimitLayer = 'PLATFORM' | 'BROKER' | 'DESK' | 'ACCOUNT';

/** Which layer set each limit that ended up binding. For a person, not a rule. */
export interface LimitProvenance {
  readonly maxPositionVolume: RiskLimitLayer | null;
  readonly maxOpenPositions: RiskLimitLayer | null;
  readonly maxGrossNotional: RiskLimitLayer | null;
  readonly maxSymbolNetVolume: RiskLimitLayer | null;
}

export interface EffectiveLimits {
  readonly limits: AccountRiskLimits;
  readonly from: LimitProvenance;
}

/** The four caps the hierarchy governs. Stop-out levels are not among them — see below. */
const CAPPED = [
  'maxPositionVolume',
  'maxOpenPositions',
  'maxGrossNotional',
  'maxSymbolNetVolume',
] as const;
type Capped = (typeof CAPPED)[number];

/**
 * What an account may actually do, once every layer above it has had its say.
 *
 * ## The hierarchy
 *
 * ```
 * platform  →  broker  →  desk  →  account
 * ```
 *
 * Each layer may tighten what the one above allows. **None may loosen it.** A
 * broker that sets a 50-lot ceiling cannot be overridden by an account
 * configured for 100; the account trades 50. This is checked when a limit is
 * written — an admin who tries to set a looser one is refused, and told which
 * layer is stopping them — and it is enforced again here, by taking the
 * tightest value across every layer, because a row that reached the table some
 * other way must not be able to widen what an account may do.
 *
 * ## Null is silence, not permission
 *
 * A layer that leaves a field null has no opinion about it and passes the
 * layer above through untouched. It does not mean "unlimited". If every layer
 * is silent the limit is unset, and the rules read an unset limit as not
 * enforced — which is the platform's existing behaviour and is not changed
 * here.
 *
 * ## The desk layer applies to the route, not to the account
 *
 * A desk ceiling binds an order **placed through that desk's delegation**. The
 * same account traded by its own owner is not subject to it, and that is the
 * point: "my operators may not put on more than a lot at a time" is a
 * statement about the operators, not about the account holder, who never
 * agreed to it. So the caller passes the master account the order arrived
 * through, or null when the owner is trading their own account.
 *
 * ## What is deliberately not here
 *
 * `marginCallLevelPercent` and `stopOutLevelPercent` stay account-only. They
 * are not caps — they are the levels at which the platform intervenes — and
 * "stricter" runs the other way for them (a *higher* stop-out level is the
 * safer one). Folding them into a min() would silently make every account's
 * stop-out the loosest one on the platform. They belong in the hierarchy
 * eventually, with their own direction; they are not in it today, and saying
 * so is better than getting it backwards.
 */
@Injectable()
export class RiskLimitsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The account's own settings, tightened by every layer above it.
   *
   * `accountSettings` is read by the caller (it also needs the stop-out
   * levels), so it is passed in rather than read twice inside one order.
   */
  async effective(
    input: {
      readonly tenantId: string;
      readonly accountLimits: AccountRiskLimits;
      /** The desk the order arrived through, or null for the account's owner. */
      readonly masterAccountId: string | null;
    },
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<EffectiveLimits> {
    const [platform, above] = await Promise.all([
      this.platformSet(client),
      client.riskLimitSet.findMany({
        where: {
          OR: [
            { level: 'BROKER', masterAccountId: null },
            ...(input.masterAccountId === null
              ? []
              : [{ level: 'DESK' as const, masterAccountId: input.masterAccountId }]),
          ],
        },
      }),
    ]);

    const layers: { layer: RiskLimitLayer; set: Partial<AccountRiskLimits> }[] = [
      { layer: 'PLATFORM', set: fromRow(platform) },
      { layer: 'BROKER', set: fromRow(above.find((row) => row.level === 'BROKER')) },
      { layer: 'DESK', set: fromRow(above.find((row) => row.level === 'DESK')) },
      { layer: 'ACCOUNT', set: input.accountLimits },
    ];

    const limits: Record<string, unknown> = { ...input.accountLimits };
    const from: Record<string, RiskLimitLayer | null> = {};

    for (const field of CAPPED) {
      let tightest: string | number | undefined;
      let source: RiskLimitLayer | null = null;
      for (const { layer, set } of layers) {
        const value = set[field];
        if (value === undefined) continue;
        if (tightest === undefined || isTighter(field, value, tightest)) {
          tightest = value;
          source = layer;
        }
      }
      if (tightest === undefined) delete limits[field];
      else limits[field] = tightest;
      from[field] = source;
    }

    return {
      limits: limits as AccountRiskLimits,
      from: from as unknown as LimitProvenance,
    };
  }

  /**
   * The platform's ceiling, read from outside the caller's tenant.
   *
   * A broker cannot see the platform tenant's rows, and must still be bound by
   * them — that is what "platform" means. The read is deliberate, narrow (one
   * row), and says so, rather than being a query that happens to escape.
   */
  private async platformSet(
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<RiskLimitSet | undefined> {
    return withoutTenantScope(
      'every firm is bound by the platform ceiling, which lives in the platform tenant',
      async () => {
        const platform = await client.tenant.findFirst({
          where: { kind: 'PLATFORM' },
          select: { id: true },
        });
        if (platform === null) return undefined;
        const row = await client.riskLimitSet.findFirst({
          where: { level: 'PLATFORM', tenantId: platform.id, masterAccountId: null },
        });
        return row ?? undefined;
      },
    );
  }
}

/**
 * Tighter, per field.
 *
 * Every cap here is a maximum, so tighter is smaller — but the comparison is
 * written per field rather than assumed globally, because the day a limit is
 * added whose stricter direction is upward (a minimum margin, a stop-out
 * level) this is the function that must refuse to guess.
 */
export function isTighter(
  field: Capped,
  candidate: string | number,
  current: string | number,
): boolean {
  switch (field) {
    case 'maxOpenPositions':
      // A count, and a small one. An integer is exact as a double, so this one
      // is spelled plainly rather than dressed up as money.
      return Number(candidate) < Number(current);
    case 'maxPositionVolume':
    case 'maxGrossNotional':
    case 'maxSymbolNetVolume':
      /**
       * Decimal strings, compared as decimals — never lexically, and never as
       * doubles.
       *
       * Lexically was the first bug: '9' sorts after '10' as text, and a
       * ceiling compared as text is a ceiling that is sometimes the wrong way
       * round. The fix for that was `Number()`, which trades one wrong answer
       * for a rarer one: these columns are `Decimal(28,10)`, and two values
       * agreeing in their first sixteen significant digits are the same
       * double. `Number('100000000000000000001') === Number('…002')`.
       *
       * That matters most where this is read as a refusal.
       * `RiskHierarchyService.refuseLooser` throws when the ceiling above is
       * tighter than what is being asked for, so a false `false` here is a
       * loosening that is not refused — a layer raising a ceiling set above it,
       * which is precisely what the hierarchy exists to prevent.
       */
      return toDecimal(candidate).lessThan(toDecimal(current));
    default: {
      const never: never = field;
      throw new Error(`no tightening rule for ${String(never)}`);
    }
  }
}

/** A stored row as the limit shape, with nulls dropped rather than turned into values. */
export function fromRow(row: RiskLimitSet | undefined): Partial<AccountRiskLimits> {
  if (row === undefined) return {};
  return {
    ...(row.maxPositionVolume === null
      ? {}
      : { maxPositionVolume: row.maxPositionVolume.toString() }),
    ...(row.maxOpenPositions === null ? {} : { maxOpenPositions: row.maxOpenPositions }),
    ...(row.maxGrossNotional === null ? {} : { maxGrossNotional: row.maxGrossNotional.toString() }),
    ...(row.maxSymbolNetVolume === null
      ? {}
      : { maxSymbolNetVolume: row.maxSymbolNetVolume.toString() }),
  };
}
