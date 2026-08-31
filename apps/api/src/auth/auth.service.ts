import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainError, TradingErrorCode, type UserRole } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { AuditService } from '../common/audit/audit.service';
import { PasswordService } from './password.service';
import { TokenService, type IssueContext } from './token.service';
import { TotpService } from './totp.service';
import { SessionsService } from './sessions.service';
import { EmailPort } from './email/email.port';
import { InvitesService } from './invites.service';
import type { Env } from '../config/env.schema';
import type { TokenPair } from './token.types';

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  /** Required when REGISTRATION_MODE=invite; ignored otherwise. */
  inviteCode?: string | undefined;
}

export interface AuthContext extends IssueContext {
  requestId?: string;
}

/**
 * What a correct password buys.
 *
 * A discriminated union rather than a `TokenPair | null`, because the caller has
 * to render two different screens and a nullable pair does not say which. The
 * challenge case is not a failure — the password *was* right — and typing it as
 * one leads to clients that show "sign-in failed" to every user with 2FA on.
 */
export type LoginResult =
  | { kind: 'authenticated'; pair: TokenPair }
  | { kind: 'twoFactorRequired'; challengeToken: string; expiresIn: number };

/**
 * A hash of a password that does not exist, used to keep the login timing of an
 * unknown email indistinguishable from a wrong password. Computed once at
 * startup rather than per request.
 */
const DUMMY_PASSWORD = randomBytes(32).toString('base64');

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private dummyHash: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly totp: TotpService,
    private readonly sessions: SessionsService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
    private readonly email: EmailPort,
    private readonly invites: InvitesService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {
    this.dummyHash = this.passwords.hash(DUMMY_PASSWORD);
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Registration.
   *
   * The user, their first demo account and its opening ledger entry are created
   * in one transaction. A user with no account, or an account with no opening
   * entry, is a state the rest of the system would have to defend against
   * forever; it is cheaper to make it impossible.
   */
  /**
   * Open an account.
   *
   * The mode check comes first, before any work and before the
   * already-registered branch, so a closed platform does not spend an Argon2
   * hash on every attempt — and, more importantly, so it does not answer
   * differently depending on whether the address exists. A refusal that leaks
   * "that email is taken" is the enumeration hole this method spends the rest
   * of its body avoiding.
   */
  async register(input: RegisterInput, context: AuthContext = {}): Promise<{ userId: string }> {
    const mode = this.config.get('REGISTRATION_MODE', { infer: true });
    if (mode === 'closed') {
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        'This platform is not open for registration.',
      );
    }
    if (mode === 'invite' && (input.inviteCode ?? '').trim().length === 0) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'Registration is by invitation. Enter the code you were given.',
      );
    }

    const passwordHash = await this.passwords.hash(input.password);
    const verificationToken = randomBytes(32).toString('base64url');

    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing !== null) {
      // Deliberately the same shape of response as a successful registration
      // would produce for the caller: see the controller. Enumerating registered
      // email addresses is a real attack, and this endpoint is unauthenticated.
      this.logger.warn({ email: input.email }, 'Registration attempted for an existing email');
      await this.sendPasswordResetHint(input.email);
      return { userId: existing.id };
    }

    /**
     * The invitation is claimed inside the same transaction that creates the
     * user, so the two commit together. Claiming first and creating after would
     * spend an invitation on a registration that then failed; creating first
     * and claiming after would let a spent code open a second account.
     */
    const { user, inviteFingerprint } = await this.prisma.$transaction(async (tx) => {
      const inviteCodeId =
        mode === 'invite' ? await this.invites.claim(tx, input.inviteCode as string) : null;

      const created = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          displayName: input.displayName,
          emailVerificationTokenHash: this.hashToken(verificationToken),
          emailVerificationExpiresAt: new Date(
            Date.now() +
              this.config.get('EMAIL_VERIFICATION_TTL_HOURS', { infer: true }) * 3_600_000,
          ),
        },
      });
      await this.accounts.openAccount(tx, created.id, { type: 'DEMO' });

      if (inviteCodeId !== null) {
        await this.invites.recordRedemption(tx, inviteCodeId, created.id);
        return {
          user: created,
          inviteFingerprint: await this.invites.fingerprintOf(tx, inviteCodeId),
        };
      }
      return { user: created, inviteFingerprint: null };
    });

    await this.email.send({
      to: input.email,
      subject: 'Verify your trading account',
      text: `Confirm your email address:\n\n${this.config.get('APP_PUBLIC_URL', { infer: true })}/verify-email?token=${verificationToken}`,
    });

    await this.audit.record({
      actorId: user.id,
      actorType: 'USER',
      action: 'USER_REGISTERED',
      resourceType: 'User',
      resourceId: user.id,
      after: {
        email: user.email,
        displayName: user.displayName,
        registrationMode: mode,
        // The fingerprint identifies the invitation. The code itself is not
        // stored here or anywhere else.
        ...(inviteFingerprint === null ? {} : { inviteFingerprint }),
      },
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    });

    return { userId: user.id };
  }

  /**
   * Login.
   *
   * Every failure returns the same error, and an unknown email still costs a
   * full Argon2 verification against a dummy hash. Without that, response time
   * alone tells an attacker which addresses are registered.
   */
  async login(email: string, password: string, context: AuthContext = {}): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (user === null) {
      await this.passwords.verify(await this.dummyHash, password);
      throw this.invalidCredentials();
    }

    if (user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now()) {
      throw new DomainError(
        TradingErrorCode.RATE_LIMITED,
        'Too many failed sign-in attempts. Try again later.',
        { retryAfterSeconds: Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000) },
      );
    }

    const valid = await this.passwords.verify(user.passwordHash, password);
    if (!valid) {
      await this.registerFailedAttempt(user.id, user.failedLoginAttempts + 1);
      await this.audit.record({
        actorId: user.id,
        actorType: 'USER',
        action: 'LOGIN_FAILED',
        resourceType: 'User',
        resourceId: user.id,
        requestId: context.requestId ?? null,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
      });
      throw this.invalidCredentials();
    }

    if (!user.isActive) {
      throw new DomainError(TradingErrorCode.FORBIDDEN, 'This account is disabled');
    }

    /**
     * The password is right. If a second factor is on, the attempt stops here.
     *
     * Note what does *not* happen yet: no tokens are issued, the failure counter
     * is not cleared, and `lastLoginAt` is not touched. Nobody has signed in.
     * Clearing the counter here would let an attacker who knows the password
     * hold the lockout open indefinitely while grinding at the six digits.
     */
    if (user.totpEnabledAt !== null) {
      const challenge = await this.tokens.issueTwoFactorChallenge(user.id);
      await this.audit.record({
        actorId: user.id,
        actorType: 'USER',
        action: 'LOGIN_SECOND_FACTOR_REQUIRED',
        resourceType: 'User',
        resourceId: user.id,
        requestId: context.requestId ?? null,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
      });
      return { kind: 'twoFactorRequired', ...challenge };
    }

    return { kind: 'authenticated', pair: await this.completeLogin(user, context) };
  }

  /**
   * Second half of a two-factor sign-in.
   *
   * The challenge proves the password; the code proves the device. Both are
   * checked here rather than trusting the challenge alone, and a wrong code
   * counts against the same lockout the password does — otherwise the second
   * factor would be the one credential in the system an attacker may guess at
   * without limit.
   */
  async completeTwoFactor(
    challengeToken: string,
    code: string,
    context: AuthContext = {},
  ): Promise<TokenPair> {
    const claims = await this.tokens.verifyTwoFactorChallenge(challengeToken);
    const user = await this.prisma.user.findUnique({ where: { id: claims.sub } });
    if (user === null || !user.isActive) {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Sign-in could not be completed');
    }
    if (user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now()) {
      throw new DomainError(
        TradingErrorCode.RATE_LIMITED,
        'Too many failed sign-in attempts. Try again later.',
        { retryAfterSeconds: Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000) },
      );
    }

    try {
      await this.totp.consume(user.id, code);
    } catch (error) {
      await this.registerFailedAttempt(user.id, user.failedLoginAttempts + 1);
      await this.audit.record({
        actorId: user.id,
        actorType: 'USER',
        action: 'LOGIN_SECOND_FACTOR_FAILED',
        resourceType: 'User',
        resourceId: user.id,
        requestId: context.requestId ?? null,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
      });
      throw error;
    }

    return this.completeLogin(user, context);
  }

  /** Everything that happens once, and only once, a sign-in has actually succeeded. */
  private async completeLogin(
    user: { id: string; email: string; role: UserRole },
    context: AuthContext,
  ): Promise<TokenPair> {
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    const pair = await this.tokens.issuePair(
      { id: user.id, email: user.email, role: user.role },
      context,
    );

    await this.audit.record({
      actorId: user.id,
      actorType: user.role === 'ADMIN' ? 'ADMIN' : 'USER',
      action: 'LOGIN',
      resourceType: 'User',
      resourceId: user.id,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    });

    // After the session exists, and unable to prevent it: a mail server being
    // down must not stop a trader reaching their positions.
    await this.sessions.noticeSignIn(user, context, this.tokens.familyOf(pair.accessToken));

    return pair;
  }

  async refresh(refreshToken: string, context: AuthContext = {}): Promise<TokenPair> {
    return this.tokens.rotate(refreshToken, context);
  }

  async logout(refreshToken: string, context: AuthContext = {}): Promise<void> {
    await this.tokens.revokeToken(refreshToken);
    await this.audit.record({
      actorType: 'USER',
      action: 'LOGOUT',
      resourceType: 'Session',
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    });
  }

  async verifyEmail(token: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { emailVerificationTokenHash: this.hashToken(token) },
    });
    if (
      user === null ||
      user.emailVerificationExpiresAt === null ||
      user.emailVerificationExpiresAt.getTime() <= Date.now()
    ) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'This verification link is invalid or has expired',
      );
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerificationTokenHash: null,
        emailVerificationExpiresAt: null,
      },
    });
    await this.audit.record({
      actorId: user.id,
      actorType: 'USER',
      action: 'EMAIL_VERIFIED',
      resourceType: 'User',
      resourceId: user.id,
    });
  }

  /**
   * Password reset request.
   *
   * Always succeeds from the caller's point of view, whether or not the address
   * is registered. This endpoint is unauthenticated; a truthful "no such user"
   * turns it into an account-enumeration oracle.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user === null) return;

    const token = randomBytes(32).toString('base64url');
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetTokenHash: this.hashToken(token),
        passwordResetExpiresAt: new Date(
          Date.now() + this.config.get('PASSWORD_RESET_TTL_MINUTES', { infer: true }) * 60_000,
        ),
      },
    });

    await this.email.send({
      to: email,
      subject: 'Reset your password',
      text: `Reset your password:\n\n${this.config.get('APP_PUBLIC_URL', { infer: true })}/reset-password?token=${token}\n\nIf you did not request this, ignore this message.`,
    });
  }

  /**
   * Completes a reset and revokes every existing session.
   *
   * If the reset was triggered because an account was compromised, leaving the
   * attacker's refresh tokens valid would defeat the entire exercise.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { passwordResetTokenHash: this.hashToken(token) },
    });
    if (
      user === null ||
      user.passwordResetExpiresAt === null ||
      user.passwordResetExpiresAt.getTime() <= Date.now()
    ) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'This reset link is invalid or has expired',
      );
    }

    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
    const revoked = await this.tokens.revokeAllForUser(user.id);

    await this.audit.record({
      actorId: user.id,
      actorType: 'USER',
      action: 'PASSWORD_RESET',
      resourceType: 'User',
      resourceId: user.id,
      after: { sessionsRevoked: revoked },
    });
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await this.passwords.verify(user.passwordHash, currentPassword))) {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Current password is incorrect');
    }
    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    const revoked = await this.tokens.revokeAllForUser(userId);
    await this.audit.record({
      actorId: userId,
      actorType: 'USER',
      action: 'PASSWORD_CHANGED',
      resourceType: 'User',
      resourceId: userId,
      after: { sessionsRevoked: revoked },
    });
  }

  private invalidCredentials(): DomainError {
    // One message for "no such user" and "wrong password". Distinguishing them
    // is the most common account-enumeration bug in login endpoints.
    return new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Invalid email or password');
  }

  private async registerFailedAttempt(userId: string, attempts: number): Promise<void> {
    const max = this.config.get('LOGIN_MAX_FAILED_ATTEMPTS', { infer: true });
    const lockMinutes = this.config.get('LOGIN_LOCKOUT_MINUTES', { infer: true });
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: attempts,
        lockedUntil: attempts >= max ? new Date(Date.now() + lockMinutes * 60_000) : null,
      },
    });
  }

  private async sendPasswordResetHint(email: string): Promise<void> {
    await this.email.send({
      to: email,
      subject: 'You already have an account',
      text: 'Someone tried to register with this address. If that was you, sign in or reset your password instead.',
    });
  }
}

/** Constant-time comparison helper for opaque tokens. */
export function safeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
