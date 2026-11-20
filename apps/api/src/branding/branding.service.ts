import { Injectable } from '@nestjs/common';
import { requireTenantId } from '@tp/tenancy';
import {
  BRAND_NAME_MAX,
  DomainError,
  TradingErrorCode,
  accentProblem,
  type Branding,
} from '@tp/shared-types';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

/** A change to branding: a field left out is unchanged, `null` clears it. */
export interface BrandingChange {
  readonly name?: string | null;
  readonly accentDark?: string | null;
  readonly accentLight?: string | null;
  readonly supportEmail?: string | null;
  readonly websiteUrl?: string | null;
}

const SELECT = {
  brandName: true,
  brandAccentDark: true,
  brandAccentLight: true,
  supportEmail: true,
  websiteUrl: true,
} as const;

type Row = {
  brandName: string | null;
  brandAccentDark: string | null;
  brandAccentLight: string | null;
  supportEmail: string | null;
  websiteUrl: string | null;
};

function view(row: Row | null): Branding {
  return {
    name: row?.brandName ?? null,
    accentDark: row?.brandAccentDark ?? null,
    accentLight: row?.brandAccentLight ?? null,
    supportEmail: row?.supportEmail ?? null,
    websiteUrl: row?.websiteUrl ?? null,
  };
}

/**
 * The firm's name, colours and contact details as its visitors see them.
 *
 * Read on every page load by people who have not signed in, so it is cached
 * per firm in this process and dropped on the write that changes it. A second
 * API process serves the old branding until its entry ages out — a minute —
 * which for a colour is acceptable and for anything else would not be.
 */
@Injectable()
export class BrandingService {
  private readonly cache = new Map<string, { at: number; value: Branding }>();
  private static readonly TTL_MS = 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async current(): Promise<Branding> {
    const tenantId = requireTenantId();
    const hit = this.cache.get(tenantId);
    if (hit !== undefined && Date.now() - hit.at < BrandingService.TTL_MS) return hit.value;
    const row = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: SELECT });
    const value = view(row);
    this.cache.set(tenantId, { at: Date.now(), value });
    return value;
  }

  async update(actorId: string, change: BrandingChange): Promise<Branding> {
    const problems = brandingProblems(change);
    if (problems.length > 0) {
      throw new DomainError(TradingErrorCode.VALIDATION_FAILED, problems.join(' '), {
        problems,
      });
    }
    const tenantId = requireTenantId();
    const before = view(
      await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: SELECT }),
    );
    const row = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        ...(change.name === undefined ? {} : { brandName: blankToNull(change.name) }),
        ...(change.accentDark === undefined ? {} : { brandAccentDark: change.accentDark }),
        ...(change.accentLight === undefined ? {} : { brandAccentLight: change.accentLight }),
        ...(change.supportEmail === undefined
          ? {}
          : { supportEmail: blankToNull(change.supportEmail) }),
        ...(change.websiteUrl === undefined ? {} : { websiteUrl: blankToNull(change.websiteUrl) }),
      },
      select: SELECT,
    });
    const after = view(row);
    this.cache.delete(tenantId);
    await this.audit.record({
      actorType: 'ADMIN',
      actorId,
      action: 'BRANDING_UPDATED',
      resourceType: 'Tenant',
      resourceId: tenantId,
      before: { ...before },
      after: { ...after },
    });
    return after;
  }
}

function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Every reason a change cannot be saved, in words for the person making it. */
export function brandingProblems(change: BrandingChange): string[] {
  const problems: string[] = [];
  if (typeof change.name === 'string' && change.name.trim().length > BRAND_NAME_MAX) {
    problems.push(`The name can be at most ${BRAND_NAME_MAX} characters.`);
  }
  for (const [theme, value] of [
    ['dark', change.accentDark],
    ['light', change.accentLight],
  ] as const) {
    if (typeof value !== 'string') continue;
    const problem = accentProblem(value, theme);
    if (problem !== null) problems.push(problem);
  }
  if (typeof change.supportEmail === 'string' && change.supportEmail.trim() !== '') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(change.supportEmail.trim())) {
      problems.push('The support address is not an email address.');
    }
  }
  if (typeof change.websiteUrl === 'string' && change.websiteUrl.trim() !== '') {
    let url: URL | null = null;
    try {
      url = new URL(change.websiteUrl.trim());
    } catch {
      url = null;
    }
    if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
      problems.push('The website must be an https:// address.');
    }
  }
  return problems;
}
