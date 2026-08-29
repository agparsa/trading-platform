import { Injectable, Logger } from '@nestjs/common';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { EmailPort } from './email/email.port';
import { coarseIp, describeDevice } from './device';

export interface SessionSummary {
  /** The rotation family. One login, however many times its token has rotated. */
  id: string;
  device: string;
  ipAddress: string | null;
  signedInAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** True for the session making the request. */
  current: boolean;
}

/**
 * What the user can see and revoke.
 *
 * A session here is a **rotation family**, not a token row. One sign-in produces
 * one family and then a new row every fifteen minutes as the access token is
 * refreshed; showing those rows would present a user with ninety-six "sessions"
 * a day from one laptop, which is worse than showing nothing — it teaches them
 * the list is noise, and the whole value of the list is that they look at it.
 *
 * On §30, and on what this deliberately does not do: the only inputs are the
 * `User-Agent` header the browser already sends and the IP the connection
 * already arrived from, both of which have been stored against each token since
 * the first migration. No fingerprinting, no location lookup, no correlation
 * with anything outside this table. The question a person is trying to answer is
 * "is one of these not me", and a browser name, a rough IP and a timestamp
 * answer it. A device hash would be more precise and would answer nothing.
 */
@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly email: EmailPort,
  ) {}

  /**
   * The user's live sessions, newest first.
   *
   * A family counts as live while it holds at least one token that is neither
   * revoked nor expired. `currentFamilyId` marks the caller's own so the UI can
   * label it — and so nobody has to guess which row not to revoke.
   */
  async list(userId: string, currentFamilyId: string | null = null): Promise<SessionSummary[]> {
    const now = new Date();

    /**
     * Liveness and history are two different questions, and answering them with
     * one query got this wrong.
     *
     * Rotation revokes the token it replaced. So the live rows are only ever the
     * *newest* token of each family — and a list built from them alone reports
     * every session as having begun at the last refresh. A laptop signed in on
     * Monday and still open on Friday would say "signed in fifteen minutes ago",
     * which is precisely the fact a user is looking at this list to check.
     *
     * So: the live rows say which sessions exist and what they look like now,
     * and a grouped query over the whole family says when each one began.
     */
    const live = await this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        familyId: true,
        userAgent: true,
        ipAddress: true,
        createdAt: true,
        expiresAt: true,
      },
    });

    const newest = new Map<string, (typeof live)[number]>();
    for (const token of live) {
      // Rows arrive newest first, so the first one seen for a family is the one
      // that describes where that session is now.
      if (!newest.has(token.familyId)) newest.set(token.familyId, token);
    }
    if (newest.size === 0) return [];

    const spans = await this.prisma.refreshToken.groupBy({
      by: ['familyId'],
      where: { userId, familyId: { in: [...newest.keys()] } },
      _min: { createdAt: true },
    });
    const began = new Map(spans.map((row) => [row.familyId, row._min.createdAt]));

    return [...newest.values()]
      .map((token) => ({
        id: token.familyId,
        device: describeDevice(token.userAgent).label,
        ipAddress: token.ipAddress,
        signedInAt: (began.get(token.familyId) ?? token.createdAt).toISOString(),
        lastSeenAt: token.createdAt.toISOString(),
        expiresAt: token.expiresAt.toISOString(),
        current: token.familyId === currentFamilyId,
      }))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  /**
   * Ends one session.
   *
   * Scoped by `userId` in the same query that finds it, so a family id belonging
   * to somebody else is not found rather than being found and then refused. The
   * two are indistinguishable to the caller, which is the point.
   */
  async revoke(
    userId: string,
    familyId: string,
    context: { requestId?: string; ipAddress?: string; userAgent?: string } = {},
  ): Promise<{ revoked: number }> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such active session');
    }

    await this.audit.record({
      actorId: userId,
      actorType: 'USER',
      action: 'SESSION_REVOKED',
      resourceType: 'Session',
      resourceId: familyId,
      after: { revokedTokens: result.count },
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    });

    return { revoked: result.count };
  }

  /**
   * Notices a sign-in from a kind of device this account has not used before.
   *
   * Keyed on the device signature — browser and system, no version — and not on
   * the IP. An IP changes when a phone moves between cells; alerting on it would
   * produce several notices a day for an ordinary commuter, and a notice that
   * arrives several times a day is not read the day it matters.
   *
   * Called after the session has been issued, and deliberately never allowed to
   * fail the sign-in: a mail server being down is not a reason to lock a trader
   * out of their positions.
   */
  async noticeSignIn(
    user: { id: string; email: string },
    context: { userAgent?: string; ipAddress?: string; requestId?: string },
    justIssuedFamilyId: string,
  ): Promise<{ newDevice: boolean }> {
    try {
      const device = describeDevice(context.userAgent);

      const previous = await this.prisma.refreshToken.findMany({
        where: { userId: user.id, familyId: { not: justIssuedFamilyId } },
        select: { userAgent: true },
        // Bounded: an account with years of sessions must not read all of them
        // on every sign-in. The most recent are the ones that describe how this
        // person actually works.
        orderBy: { createdAt: 'desc' },
        take: 200,
      });

      const seen = new Set(previous.map((row) => describeDevice(row.userAgent).signature));
      if (seen.size === 0 || seen.has(device.signature)) return { newDevice: false };

      const where = coarseIp(context.ipAddress);
      await this.audit.record({
        actorId: user.id,
        actorType: 'USER',
        action: 'LOGIN_FROM_NEW_DEVICE',
        resourceType: 'Session',
        resourceId: justIssuedFamilyId,
        after: { device: device.label, ipAddress: context.ipAddress ?? null },
        requestId: context.requestId ?? null,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
      });

      await this.email.send({
        to: user.email,
        subject: 'New sign-in to your trading account',
        text: [
          `Your account was signed into from ${device.label}${where === null ? '' : ` (${where})`}.`,
          '',
          'If this was you, nothing needs doing.',
          '',
          'If it was not, change your password now and end the session from',
          'Security in the terminal. Turning on two-factor authentication there',
          'means a password alone is no longer enough to sign in.',
        ].join('\n'),
      });

      return { newDevice: true };
    } catch (error) {
      // Never fails the sign-in. The user is already authenticated; refusing
      // them a session because a notice could not be sent would be a security
      // feature locking people out of their positions.
      this.logger.error(
        { userId: user.id, error: error instanceof Error ? error.message : 'unknown' },
        'Could not check or announce a new-device sign-in',
      );
      return { newDevice: false };
    }
  }
}
