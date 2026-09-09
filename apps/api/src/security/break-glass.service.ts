import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainError, TradingErrorCode, UserRole, permissionsFor } from '@tp/shared-types';
import { requireTenantId } from '@tp/tenancy';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import type { Env } from '../config/env.schema';

export interface LiveGrant {
  readonly id: string;
  readonly subjectUserId: string;
  readonly subjectEmail: string;
  readonly reason: string;
  readonly expiresAt: Date;
}

/** The shortest reason the database will take, repeated here for a better message. */
const MIN_REASON = 8;

/**
 * Break-glass: a member of staff, temporarily seeing what one trader sees (§9).
 *
 * ## Why a grant rather than a token
 *
 * Minting an access token that says "you are the trader" is the obvious design
 * and the wrong one. Every downstream check would see the trader, the audit
 * trail would name the trader as the actor, and revoking mid-session would mean
 * chasing a token already issued.
 *
 * Here the staff member stays themselves for the whole session and carries a
 * row. Revocation is an `UPDATE`. The audit trail always names the person who
 * actually did it. "May this person see that person's data" is asked per
 * request against the database's clock rather than trusted from a claim minted
 * fifteen minutes ago.
 *
 * ## The four refusals
 *
 * 1. **Never across tenants.** A broker's staff cannot reach the platform's
 *    users or another firm's traders.
 * 2. **Never upward.** A subject holding a permission the actor does not is
 *    refused — otherwise support tooling is a route to becoming a super
 *    administrator.
 * 3. **Never yourself.** Always either a mistake or an attempt to make an
 *    ordinary action look supervised.
 * 4. **Never write.** The guard refuses every non-GET request made under a
 *    grant. `READ_WRITE` exists in the enum because §9 describes it, and is
 *    refused here: a support person trading as a customer needs controls a firm
 *    has to decide on, and inventing them would be inventing a policy nobody
 *    agreed to.
 */
@Injectable()
export class BreakGlassService {
  private readonly logger = new Logger(BreakGlassService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
  ) {}

  async open(args: {
    readonly actorId: string;
    readonly actorRole: UserRole;
    readonly subjectUserId: string;
    readonly reason: string;
    readonly minutes?: number;
  }): Promise<{ id: string; expiresAt: Date }> {
    const reason = args.reason.trim();
    if (reason.length < MIN_REASON) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'A break-glass needs a reason somebody can be asked about afterwards',
        { minimum: MIN_REASON },
      );
    }
    if (args.actorId === args.subjectUserId) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'Nobody breaks glass on themselves',
      );
    }

    /**
     * Read inside the tenant. A subject in another firm is simply not found,
     * which is also the answer we want to give: telling a caller that a user id
     * is valid *somewhere* is telling them where to look next.
     */
    const subject = await this.prisma.user.findUnique({
      where: { id: args.subjectUserId },
      select: { id: true, email: true, role: true, isActive: true },
    });
    if (subject === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such user');
    }
    if (!subject.isActive) {
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        'That account is disabled; there is nothing to look at',
      );
    }

    /**
     * Never upward — and "upward" means *staff* powers, not any difference.
     *
     * The first version of this rule refused every trader, and was right to
     * fail: an administrator deliberately cannot place an order, so a plain
     * trader holds permissions the administrator does not. Those are a
     * separation of duties, not seniority, and comparing raw permission sets
     * mistakes one for the other.
     *
     * So the baseline every ordinary user holds is subtracted first, and what
     * remains is what the subject can do *as staff*. An administrator reading a
     * super administrator's view would see the whole platform through their
     * eyes; that is the escalation this refuses, and it is a real one even
     * though the grant is read-only.
     *
     * Comparing role names instead would be a guess that goes wrong the first
     * time somebody adds a role.
     */
    const baseline = new Set<string>(permissionsFor(UserRole.USER));
    const held = new Set<string>(permissionsFor(args.actorRole));
    const beyond = permissionsFor(subject.role).filter(
      (permission) => !baseline.has(permission) && !held.has(permission),
    );
    if (beyond.length > 0) {
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        'That person holds staff powers you do not; break-glass never looks upward',
        { theyHold: beyond.slice(0, 5).join(', ') },
      );
    }

    const maxMs = this.config.getOrThrow('BREAK_GLASS_MAX_TTL_MS', { infer: true });
    const askedMs = (args.minutes ?? 0) * 60_000;
    const ttlMs = askedMs > 0 ? Math.min(askedMs, maxMs) : maxMs;

    const grant = await this.prisma.breakGlassGrant.create({
      data: {
        tenantId: requireTenantId(),
        actorId: args.actorId,
        subjectUserId: subject.id,
        reason,
        scope: 'READ_ONLY',
        expiresAt: new Date(Date.now() + ttlMs),
      },
      select: { id: true, expiresAt: true },
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: args.actorId,
      action: 'BREAK_GLASS_OPENED',
      resourceType: 'User',
      resourceId: subject.id,
      after: { grantId: grant.id, reason, expiresAt: grant.expiresAt.toISOString() },
    });

    /*
     * The subject's security feed is written by the audit row above, through
     * `SECURITY_KINDS` — `BREAK_GLASS_OPENED` is mapped there with
     * `subject: 'resource'`, so it lands in the account owner's feed rather
     * than the staff member's. Somebody looked at your account is a thing you
     * are entitled to know, and a break-glass nobody outside the room can see
     * is indistinguishable from snooping.
     */

    this.logger.warn(
      { grantId: grant.id, actorId: args.actorId, subjectId: subject.id },
      'Break-glass opened',
    );
    return grant;
  }

  /**
   * Resolve a grant for one request, and count the use.
   *
   * Returns `null` for anything that is not a live grant belonging to this
   * actor: expired, ended, somebody else's, another firm's, or absent. The
   * caller treats `null` as "no grant" rather than as an error, so a stale
   * grant id in a browser tab degrades to the staff member's own view instead
   * of a wall of failures.
   *
   * The expiry is compared in the database, not in this process. Same reason
   * the leadership lease is: one clock, shared by everything that asks.
   */
  async resolve(actorId: string, grantId: string): Promise<LiveGrant | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        subject_user_id: string;
        email: string;
        reason: string;
        expires_at: Date;
      }>
    >`
      UPDATE break_glass_grants g
         SET uses = g.uses + 1
        FROM users u
       WHERE g.id = ${grantId}::uuid
         AND g.actor_id = ${actorId}::uuid
         AND g.ended_at IS NULL
         AND g.expires_at > now()
         AND u.id = g.subject_user_id
      RETURNING g.id, g.subject_user_id, u.email, g.reason, g.expires_at
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      subjectUserId: row.subject_user_id,
      subjectEmail: row.email,
      reason: row.reason,
      expiresAt: row.expires_at,
    };
  }

  /** End a grant early. Idempotent: ending an ended grant is not an error. */
  async close(actorId: string, grantId: string): Promise<void> {
    const { count } = await this.prisma.breakGlassGrant.updateMany({
      where: { id: grantId, actorId, endedAt: null },
      data: { endedAt: new Date(), endedByUserId: actorId },
    });
    if (count === 0) return;

    const grant = await this.prisma.breakGlassGrant.findUnique({
      where: { id: grantId },
      select: { subjectUserId: true, uses: true },
    });
    await this.audit.record({
      actorType: 'ADMIN',
      actorId,
      action: 'BREAK_GLASS_CLOSED',
      resourceType: 'User',
      resourceId: grant?.subjectUserId ?? null,
      after: { grantId, uses: grant?.uses ?? 0 },
    });
  }

  /** This person's own grants, newest first — what the console shows them. */
  async mine(actorId: string) {
    return this.prisma.breakGlassGrant.findMany({
      where: { actorId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        reason: true,
        scope: true,
        expiresAt: true,
        endedAt: true,
        uses: true,
        createdAt: true,
        subject: { select: { id: true, email: true, displayName: true } },
      },
    });
  }

  /**
   * Every grant in the firm, for whoever reviews them.
   *
   * A break-glass feature nobody reviews is a back door with paperwork. This is
   * the list somebody reads on a Monday, so it is ordered by when it happened
   * and carries the reason in full rather than truncated.
   */
  async all(limit = 200) {
    return this.prisma.breakGlassGrant.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 500),
      select: {
        id: true,
        reason: true,
        scope: true,
        expiresAt: true,
        endedAt: true,
        uses: true,
        createdAt: true,
        actor: { select: { id: true, email: true, displayName: true } },
        subject: { select: { id: true, email: true, displayName: true } },
      },
    });
  }
}
