import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { SecretBoxService } from '../common/crypto/crypto.module';
import { PasswordService } from './password.service';
import {
  base32Decode,
  generateRecoveryCode,
  generateSecret,
  matchCode,
  normaliseRecoveryCode,
  otpauthUri,
  RECOVERY_CODE_COUNT,
} from './totp';
import type { Env } from '../config/env.schema';
import { requireTenantId } from '@tp/tenancy';

export interface EnrolmentOffer {
  /** Shown once, so a user without a camera can type it in. */
  secret: string;
  otpauthUri: string;
}

export interface TotpStatus {
  enabled: boolean;
  enabledAt: string | null;
  /** Enrolment begun and never proved. Worth telling the user about. */
  pending: boolean;
  recoveryCodesRemaining: number;
}

/** How the sealed secret is bound to its row. Changing this invalidates every enrolment. */
function contextFor(userId: string): string {
  return `user:${userId}:totp`;
}

function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');
}

/**
 * Two-factor authentication.
 *
 * Four rules shape everything below.
 *
 * **An enrolment is not on until it has been proved.** `beginEnrolment` stores a
 * secret and leaves `totpEnabledAt` null. If the user closes the tab before
 * scanning, or scans into an app on a phone they then drop in a river, nothing
 * has happened to their account. Storing the secret and switching 2FA on in one
 * step is how people lock themselves out, and they lock themselves out at the
 * moment they were trying to be careful.
 *
 * **A code works once.** `matchCode` returns the step it matched; that step is
 * written to the row in the same statement that checks it, conditionally, so two
 * simultaneous submissions of one code cannot both win.
 *
 * **Nothing here is a silent no-op.** Every refusal is a distinct error the
 * caller can act on. A 2FA implementation that returns "invalid" for a
 * misconfigured secret looks, to the user, exactly like their phone being wrong,
 * and they will spend an hour proving their phone is right.
 *
 * **Turning it off costs as much as turning it on.** Disabling asks for the
 * password *and* a current code, because an attacker holding a stolen session
 * would otherwise simply remove the factor that was in their way.
 */
@Injectable()
export class TotpService {
  private readonly logger = new Logger(TotpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBoxService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  async status(userId: string): Promise<TotpStatus> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpSecret: true, totpEnabledAt: true },
    });
    const remaining =
      user.totpEnabledAt === null
        ? 0
        : await this.prisma.totpRecoveryCode.count({ where: { userId, usedAt: null } });

    return {
      enabled: user.totpEnabledAt !== null,
      enabledAt: user.totpEnabledAt?.toISOString() ?? null,
      pending: user.totpSecret !== null && user.totpEnabledAt === null,
      recoveryCodesRemaining: remaining,
    };
  }

  /**
   * Starts enrolment: a fresh secret, sealed, not yet in force.
   *
   * Calling it again before proving replaces the pending secret. That is
   * deliberate — the usual reason to call it twice is that the first QR code
   * went to a device the user no longer has.
   */
  async beginEnrolment(userId: string): Promise<EnrolmentOffer> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, totpEnabledAt: true },
    });
    if (user.totpEnabledAt !== null) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'Two-factor authentication is already on. Turn it off before enrolling again.',
      );
    }

    const secret = generateSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        totpSecret: this.secrets.seal(secret, contextFor(userId)),
        // A restarted enrolment must not inherit the replay high-water mark of
        // an abandoned one, or the first code from the new secret is refused
        // for being "old".
        totpLastStep: null,
      },
    });

    return {
      secret,
      otpauthUri: otpauthUri(secret, user.email, this.config.get('TOTP_ISSUER', { infer: true })),
    };
  }

  /**
   * Proves the enrolment and switches it on, returning the recovery codes.
   *
   * The codes are shown here and never again — only their hashes are kept — so
   * this is the one response in the system a user genuinely has to write down.
   */
  async activate(
    userId: string,
    code: string,
    requestId?: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpSecret: true, totpEnabledAt: true },
    });
    if (user.totpEnabledAt !== null) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'Two-factor authentication is already on',
      );
    }
    if (user.totpSecret === null) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'Start enrolment before confirming a code',
      );
    }

    const match = matchCode(this.openSecret(userId, user.totpSecret), code, Date.now());
    if (match === null) {
      throw new DomainError(
        TradingErrorCode.TWO_FACTOR_INVALID,
        'That code is not right. Check your device clock if it keeps failing.',
      );
    }

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { totpEnabledAt: new Date(), totpLastStep: BigInt(match.step) },
      });
      // Replacing any codes from an earlier enrolment: a code printed for a
      // secret that no longer exists must not still open the door.
      await tx.totpRecoveryCode.deleteMany({ where: { userId } });
      await tx.totpRecoveryCode.createMany({
        data: codes.map((value) => ({
          tenantId: requireTenantId(),
          userId,
          codeHash: hashRecoveryCode(value),
        })),
      });
    });

    await this.audit.record({
      actorId: userId,
      actorType: 'USER',
      action: 'TWO_FACTOR_ENABLED',
      resourceType: 'User',
      resourceId: userId,
      requestId: requestId ?? null,
    });

    return { recoveryCodes: codes };
  }

  /** Turning it off needs the password and a live code. */
  async disable(userId: string, password: string, code: string, requestId?: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true, totpSecret: true, totpEnabledAt: true, totpLastStep: true },
    });
    if (user.totpEnabledAt === null || user.totpSecret === null) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'Two-factor authentication is not on',
      );
    }
    if (!(await this.passwords.verify(user.passwordHash, password))) {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Password is not correct');
    }
    await this.consume(userId, code);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null },
      });
      await tx.totpRecoveryCode.deleteMany({ where: { userId } });
    });

    await this.audit.record({
      actorId: userId,
      actorType: 'USER',
      action: 'TWO_FACTOR_DISABLED',
      resourceType: 'User',
      resourceId: userId,
      requestId: requestId ?? null,
    });
  }

  /**
   * Accepts a code or a recovery code, exactly once.
   *
   * Throws on every failure; a caller that gets no exception may proceed. The
   * step is claimed with a conditional update rather than a read followed by a
   * write, so two requests carrying the same code at the same moment cannot both
   * be accepted — the second updates no rows and is refused as a replay.
   */
  async consume(userId: string, presented: string): Promise<{ usedRecoveryCode: boolean }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpSecret: true, totpEnabledAt: true },
    });
    if (user.totpEnabledAt === null || user.totpSecret === null) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'Two-factor authentication is not on for this account',
      );
    }

    const normalised = presented.trim();
    if (/^[0-9]{6}$/.test(normalised)) {
      const match = matchCode(this.openSecret(userId, user.totpSecret), normalised, Date.now());
      if (match === null) throw this.invalidCode();

      const claimed = await this.prisma.$executeRaw`
        UPDATE users
           SET totp_last_step = ${BigInt(match.step)}
         WHERE id = ${userId}::uuid
           AND (totp_last_step IS NULL OR totp_last_step < ${BigInt(match.step)})
      `;
      if (claimed === 0) {
        // The code is arithmetically valid and has already been spent. This is
        // what a replayed code looks like, and it is worth its own log line:
        // legitimate users do not produce it.
        this.logger.warn({ userId }, 'A one-time code was presented twice');
        throw this.invalidCode();
      }
      return { usedRecoveryCode: false };
    }

    const spent = await this.prisma.totpRecoveryCode.updateMany({
      where: { userId, codeHash: hashRecoveryCode(normalised), usedAt: null },
      data: { usedAt: new Date() },
    });
    if (spent.count === 0) throw this.invalidCode();

    const remaining = await this.prisma.totpRecoveryCode.count({ where: { userId, usedAt: null } });
    this.logger.warn({ userId, remaining }, 'A recovery code was used to sign in');
    await this.audit.record({
      actorId: userId,
      actorType: 'USER',
      action: 'TWO_FACTOR_RECOVERY_CODE_USED',
      resourceType: 'User',
      resourceId: userId,
      after: { remaining },
    });
    return { usedRecoveryCode: true };
  }

  /**
   * Unseals the stored secret.
   *
   * A failure here is not a wrong code — it is a key that is missing, or a row
   * that has been tampered with — and it must not be reported as one. Telling a
   * user their code is wrong when the server cannot read their secret sends them
   * to check their phone forever.
   */
  private openSecret(userId: string, sealed: string): Buffer {
    try {
      return base32Decode(this.secrets.open(sealed, contextFor(userId)));
    } catch (error) {
      this.logger.error(
        { userId, error: error instanceof Error ? error.name : 'unknown' },
        'Stored TOTP secret could not be opened',
      );
      throw new DomainError(
        TradingErrorCode.INTERNAL_ERROR,
        'Two-factor authentication is temporarily unavailable for this account. Contact support.',
      );
    }
  }

  private invalidCode(): DomainError {
    return new DomainError(
      TradingErrorCode.TWO_FACTOR_INVALID,
      'That code is not right, or has already been used',
    );
  }
}
