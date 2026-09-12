import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { toDecimal } from '@tp/financial-core';
import { DomainError, TradingErrorCode, type UserRole } from '@tp/shared-types';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../auth/sessions.service';
import { RiskHierarchyService } from './risk-hierarchy.service';
import { DevicesService } from '../devices/devices.service';
import { RolesService } from '../permissions/roles.service';
import { requireTenantId } from '@tp/tenancy';

/**
 * Reading and changing other people's accounts.
 *
 * Two rules shape everything here.
 *
 * **Nothing in this file changes what an account is worth.** Freezing an
 * account, restricting it to closing trades, suspending a user — all of those
 * change what somebody may *do*. Changing a balance is a different power with a
 * different permission and its own service, because there is no version of
 * "edit the money" that is a smaller act than "stop the trading". See
 * `AdjustmentsService`.
 *
 * **Every change is recorded before it is answered.** Not after, and not
 * "best effort alongside": an administrator who suspends an account and a log
 * that does not mention it is precisely the pair a dispute turns on.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
    private readonly roles: RolesService,
    private readonly hierarchy: RiskHierarchyService,
    private readonly devices: DevicesService,
  ) {}

  /**
   * Find people.
   *
   * Bounded, always. A support tool whose default is "every user" is a support
   * tool that will one day be opened on a production database with a million
   * rows in it, during an incident.
   */
  async findUsers(query: {
    search?: string;
    role?: string;
    active?: boolean;
    limit?: number;
  }): Promise<UserSummary[]> {
    const where: Prisma.UserWhereInput = {};
    const search = query.search?.trim();
    if (search !== undefined && search !== '') {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (query.role !== undefined) where.role = query.role as Prisma.UserWhereInput['role'];
    if (query.active !== undefined) where.isActive = query.active;

    const users = await this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(query.limit ?? 50, 1), 200),
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        isActive: true,
        emailVerified: true,
        totpEnabledAt: true,
        lastLoginAt: true,
        lockedUntil: true,
        failedLoginAttempts: true,
        createdAt: true,
        _count: { select: { accounts: true } },
      },
    });

    return users.map(toUserSummary);
  }

  /** One person, with their accounts and live sessions. */
  async userDetail(userId: string): Promise<UserDetail> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        isActive: true,
        emailVerified: true,
        totpEnabledAt: true,
        lastLoginAt: true,
        lockedUntil: true,
        failedLoginAttempts: true,
        createdAt: true,
        _count: { select: { accounts: true } },
        accounts: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            number: true,
            type: true,
            status: true,
            currency: true,
            balance: true,
            leverage: true,
            createdAt: true,
            _count: { select: { positions: true } },
          },
        },
      },
    });

    if (user === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such user', { userId });
    }

    const summary = toUserSummary(user);
    return {
      ...summary,
      accountCount: summary.accounts,
      accounts: user.accounts.map((account) => ({
        id: account.id,
        number: account.number,
        type: account.type,
        status: account.status,
        currency: account.currency,
        balance: account.balance.toString(),
        leverage: account.leverage,
        createdAt: account.createdAt.toISOString(),
        positions: account._count.positions,
      })),
      sessions: await this.sessions.list(userId),
    };
  }

  /**
   * Stop somebody signing in, and end the sessions they already have.
   *
   * Both halves, always. Marking a user inactive without revoking their refresh
   * tokens leaves whoever is logged in able to keep trading until the access
   * token expires and the refresh silently fails — which reads, from the
   * outside, as an account that was suspended and went on trading anyway.
   */
  async setUserActive(
    actorId: string,
    userId: string,
    active: boolean,
    reason: string,
  ): Promise<{ userId: string; isActive: boolean; sessionsEnded: number }> {
    if (actorId === userId && !active) {
      // Not paternalism: an administrator who locks themselves out during an
      // incident has removed the person who can undo it.
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'You cannot suspend your own account',
      );
    }

    const before = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isActive: true, email: true },
    });
    if (before === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such user', { userId });
    }

    await this.prisma.user.update({ where: { id: userId }, data: { isActive: active } });
    const sessionsEnded = active ? 0 : await this.sessions.revokeAll(userId);

    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: active ? 'user.reinstated' : 'user.suspended',
      resourceType: 'user',
      resourceId: userId,
      before: { isActive: before.isActive },
      after: { isActive: active, reason, sessionsEnded },
    });

    return { userId, isActive: active, sessionsEnded };
  }

  /**
   * End every session a user has, without changing whether they may sign in.
   *
   * A different act from suspending: this is what a stolen laptop needs. The
   * user signs in again and carries on.
   */
  /**
   * Somebody's devices, for staff investigating. Read-only and audited
   * nowhere: looking at a list is not an act, and an audit row per page view
   * would bury the acts that are.
   */
  async userDevices(userId: string) {
    await this.requireUser(userId);
    return this.devices.listFor(userId);
  }

  /**
   * Staff revoke a device — the lost-phone case (§13-14).
   *
   * Audited against the **user**, not the device, so it lands in that person's
   * own security feed: a revocation only the office can see is
   * indistinguishable from one that never happened. The same reasoning as
   * break-glass.
   *
   * Note for whoever reads the audit row later: this stops notifications and
   * takes the push token back. It does not end a session, because sessions are
   * not bound to devices here — pair it with `sign-out` when the handset is in
   * the wrong hands.
   */
  async revokeDevice(
    actorId: string,
    userId: string,
    deviceId: string,
    reason: string,
  ): Promise<{ userId: string; deviceId: string }> {
    await this.requireUser(userId);
    await this.devices.revokeForUser(userId, deviceId);
    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'user.device_revoked',
      resourceType: 'user',
      resourceId: userId,
      after: { reason, deviceId },
    });
    return { userId, deviceId };
  }

  /** Staff put one back: the phone turned up, or it was revoked in error. */
  async restoreDevice(
    actorId: string,
    userId: string,
    deviceId: string,
    reason: string,
  ): Promise<{ userId: string; deviceId: string }> {
    await this.requireUser(userId);
    await this.devices.restoreForUser(userId, deviceId);
    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'user.device_restored',
      resourceType: 'user',
      resourceId: userId,
      after: { reason, deviceId },
    });
    return { userId, deviceId };
  }

  /**
   * That the person exists, before acting on something of theirs.
   *
   * Without this a device id belonging to another tenant's user would answer
   * "no such device" — true, but it answers the same way for a user who does
   * not exist at all, and staff chasing a lost phone deserve to know which of
   * the two they are looking at.
   */
  private async requireUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (user === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such user', { userId });
    }
  }

  async forceSignOut(
    actorId: string,
    userId: string,
    reason: string,
  ): Promise<{ userId: string; sessionsEnded: number }> {
    const sessionsEnded = await this.sessions.revokeAll(userId);
    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'user.sessions_revoked',
      resourceType: 'user',
      resourceId: userId,
      after: { reason, sessionsEnded },
    });
    return { userId, sessionsEnded };
  }

  /**
   * Puts a person into a role.
   *
   * The most consequential administrative act on the platform: every other
   * check reads the role, so changing it changes all of them at once. Three
   * rules, each for a reason.
   *
   *   - **Not yourself.** An administrator who could promote themselves would
   *     hold every role at once by stages, and one who demoted themselves by
   *     mistake would have nobody left to undo it.
   *   - **Every session of the target ends.** The role travels in the access
   *     token, so a session minted before the change would keep the old
   *     capabilities until it expired — and the change most worth making
   *     quickly is a demotion.
   *   - **A reason, recorded.** Who may do what is the first thing an auditor
   *     reads, and a role change with no reason is a line they cannot read.
   */
  async assignRole(input: {
    readonly actorId: string;
    /** What the actor holds, so they cannot hand out more than that. */
    readonly actorRole: string;
    readonly userId: string;
    readonly role: UserRole;
    readonly reason: string;
  }): Promise<{ userId: string; role: UserRole; sessionsEnded: number }> {
    if (input.userId === input.actorId) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'You cannot change your own role. Ask another administrator.',
      );
    }
    await this.roles.assertAssignable(input.role, input.actorRole);
    const user = await this.prisma.user.findFirst({
      where: { id: input.userId },
      select: { id: true, role: true },
    });
    if (user === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'User not found');
    }
    if (user.role === input.role) {
      return { userId: user.id, role: input.role, sessionsEnded: 0 };
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { role: input.role } });
    const sessionsEnded = await this.sessions.revokeAll(user.id);

    await this.audit.record({
      actorId: input.actorId,
      actorType: 'ADMIN',
      action: 'user.role_assigned',
      resourceType: 'user',
      resourceId: user.id,
      before: { role: user.role },
      after: { role: input.role, reason: input.reason, sessionsEnded },
    });
    return { userId: user.id, role: input.role, sessionsEnded };
  }

  /** Clear a lockout from failed sign-in attempts. */
  async unlock(actorId: string, userId: string): Promise<{ userId: string }> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { lockedUntil: null, failedLoginAttempts: 0 },
    });
    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'user.unlocked',
      resourceType: 'user',
      resourceId: userId,
    });
    return { userId };
  }

  /** Find accounts. Bounded, like `findUsers`, and for the same reason. */
  async findAccounts(query: {
    search?: string;
    status?: string;
    limit?: number;
  }): Promise<AccountSummaryRow[]> {
    const where: Prisma.AccountWhereInput = {};
    const search = query.search?.trim();
    if (search !== undefined && search !== '') {
      where.OR = [
        { number: { contains: search, mode: 'insensitive' } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }
    if (query.status !== undefined) {
      where.status = query.status as Prisma.AccountWhereInput['status'];
    }

    const accounts = await this.prisma.account.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(query.limit ?? 50, 1), 200),
      select: {
        id: true,
        number: true,
        type: true,
        status: true,
        currency: true,
        balance: true,
        leverage: true,
        createdAt: true,
        user: { select: { id: true, email: true } },
        _count: { select: { positions: true } },
      },
    });

    return accounts.map((account) => ({
      id: account.id,
      number: account.number,
      type: account.type,
      status: account.status,
      currency: account.currency,
      balance: account.balance.toString(),
      leverage: account.leverage,
      createdAt: account.createdAt.toISOString(),
      userId: account.user.id,
      email: account.user.email,
      positions: account._count.positions,
    }));
  }

  /**
   * One account, by id.
   *
   * The list is a search; this is a link. An operator working an incident is
   * given an account number in a message and needs to arrive at that account,
   * not at a search box they then have to retype it into — which is the whole
   * argument for the route existing.
   *
   * `RESOURCE_NOT_FOUND` rather than a forbidden for an account in another
   * tenant, and the tenant scope makes that automatic: the row simply is not
   * there. A forbidden would confirm the account exists, which tells an
   * attacker their guessed id was right.
   */
  async accountDetail(id: string): Promise<AccountSummaryRow> {
    const account = await this.prisma.account.findFirst({
      where: { id },
      select: {
        id: true,
        number: true,
        type: true,
        status: true,
        currency: true,
        balance: true,
        leverage: true,
        createdAt: true,
        user: { select: { id: true, email: true } },
        _count: { select: { positions: true } },
      },
    });
    if (account === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such account');
    }
    return {
      id: account.id,
      number: account.number,
      type: account.type,
      status: account.status,
      currency: account.currency,
      balance: account.balance.toString(),
      leverage: account.leverage,
      createdAt: account.createdAt.toISOString(),
      userId: account.user.id,
      email: account.user.email,
      positions: account._count.positions,
    };
  }

  /**
   * Change what an account may do.
   *
   * `CLOSE_ONLY` exists so that the answer to "this account is in trouble" is
   * not forced to be "stop it dead". A trader who may still close is a trader
   * who can reduce their own risk; a trader who is frozen with positions open
   * has had their hands tied around a live exposure, and the platform now owns
   * that exposure whether it wants to or not.
   */
  async setAccountStatus(
    actorId: string,
    accountId: string,
    status: 'PENDING' | 'ACTIVE' | 'RESTRICTED' | 'CLOSE_ONLY' | 'LOCKED' | 'SUSPENDED' | 'CLOSED',
    reason: string,
  ): Promise<{ accountId: string; status: string; openPositions: number }> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { status: true, _count: { select: { positions: true } } },
    });
    if (account === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such account', { accountId });
    }

    const openPositions = await this.prisma.position.count({
      where: { accountId, status: { in: ['OPEN', 'CLOSING'] } },
    });

    /**
     * Closing an account with money at risk is refused.
     *
     * CLOSED is terminal, and a terminal state reached while positions are open
     * leaves exposure nobody is watching and nobody may act on. Suspend it,
     * close the positions, then close the account.
     */
    if (status === 'CLOSED' && openPositions > 0) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `Account has ${openPositions} open position(s). Close them before closing the account.`,
        { accountId, openPositions },
      );
    }

    await this.prisma.account.update({ where: { id: accountId }, data: { status } });

    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'account.status_changed',
      resourceType: 'account',
      resourceId: accountId,
      before: { status: account.status },
      after: { status, reason, openPositions },
    });

    return { accountId, status, openPositions };
  }

  /** An account's risk thresholds and per-account limits. */
  async setAccountLimits(
    actorId: string,
    accountId: string,
    limits: {
      marginCallLevelPercent?: string;
      stopOutLevelPercent?: string;
      maxPositionVolume?: string | null;
      maxOpenPositions?: number | null;
      maxGrossNotional?: string | null;
      maxSymbolNetVolume?: string | null;
    },
  ): Promise<{ accountId: string }> {
    const before = await this.prisma.accountSettings.findUnique({ where: { accountId } });

    /**
     * A stop-out at or above the margin call is refused.
     *
     * The two levels have an order: a margin call warns, a stop-out acts. Set
     * the wrong way round, the account is liquidated at the moment it was meant
     * to be warned, and the warning never fires at all.
     */
    const marginCall = limits.marginCallLevelPercent ?? before?.marginCallLevelPercent.toString();
    const stopOut = limits.stopOutLevelPercent ?? before?.stopOutLevelPercent.toString();
    if (marginCall !== undefined && stopOut !== undefined) {
      if (toDecimal(stopOut).gte(toDecimal(marginCall))) {
        throw new DomainError(
          TradingErrorCode.VALIDATION_FAILED,
          `The stop-out level (${stopOut}%) must be below the margin-call level (${marginCall}%), or the account is liquidated at the moment it should be warned.`,
          { marginCall, stopOut },
        );
      }
    }

    /**
     * And an account may not be configured looser than the layers above it.
     *
     * The resolver would clamp it anyway — it takes the tightest value across
     * platform, broker, desk and account — but clamping silently would leave
     * an administrator looking at a 100-lot ceiling they saved while their
     * traders are refused at 50. Better to refuse the save and name the layer.
     */
    await this.hierarchy.assertWithinCeiling(limits);

    const data = {
      ...(limits.marginCallLevelPercent === undefined
        ? {}
        : { marginCallLevelPercent: limits.marginCallLevelPercent }),
      ...(limits.stopOutLevelPercent === undefined
        ? {}
        : { stopOutLevelPercent: limits.stopOutLevelPercent }),
      ...(limits.maxPositionVolume === undefined
        ? {}
        : { maxPositionVolume: limits.maxPositionVolume }),
      ...(limits.maxOpenPositions === undefined
        ? {}
        : { maxOpenPositions: limits.maxOpenPositions }),
      ...(limits.maxGrossNotional === undefined
        ? {}
        : { maxGrossNotional: limits.maxGrossNotional }),
      ...(limits.maxSymbolNetVolume === undefined
        ? {}
        : { maxSymbolNetVolume: limits.maxSymbolNetVolume }),
    };

    await this.prisma.accountSettings.upsert({
      where: { accountId },
      create: { tenantId: requireTenantId(), accountId, ...data },
      update: data,
    });

    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'account.limits_changed',
      resourceType: 'account',
      resourceId: accountId,
      before: before === null ? undefined : JSON.parse(JSON.stringify(before)),
      after: data,
    });

    return { accountId };
  }
}

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  role: string;
  isActive: boolean;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  failedLoginAttempts: number;
  createdAt: string;
  accounts: number;
}

export interface AdminAccountRow {
  id: string;
  number: string;
  type: string;
  status: string;
  currency: string;
  balance: string;
  leverage: number;
  createdAt: string;
  positions: number;
}

export interface AccountSummaryRow extends AdminAccountRow {
  userId: string;
  email: string;
}

export interface UserDetail extends Omit<UserSummary, 'accounts'> {
  /** How many accounts, kept from the summary shape so lists and detail agree. */
  accountCount: number;
  accounts: AdminAccountRow[];
  sessions: unknown[];
}

function toUserSummary(user: {
  id: string;
  email: string;
  displayName: string;
  role: string;
  isActive: boolean;
  emailVerified: boolean;
  totpEnabledAt: Date | null;
  lastLoginAt: Date | null;
  lockedUntil: Date | null;
  failedLoginAttempts: number;
  createdAt: Date;
  _count: { accounts: number };
}): UserSummary {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    isActive: user.isActive,
    emailVerified: user.emailVerified,
    // The timestamp itself is not exposed: whether 2FA is on is what an
    // administrator needs, and when somebody enrolled is not their business.
    twoFactorEnabled: user.totpEnabledAt !== null,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    lockedUntil: user.lockedUntil?.toISOString() ?? null,
    failedLoginAttempts: user.failedLoginAttempts,
    createdAt: user.createdAt.toISOString(),
    accounts: user._count.accounts,
  };
}
