import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import { DomainError, TradingErrorCode } from '@tp/shared-types';

/**
 * Password hashing.
 *
 * Argon2id with OWASP's recommended parameters: 19 MiB of memory, two
 * iterations, one lane. Memory hardness is the point — it is what makes a
 * leaked hash expensive to attack on GPUs, which a fast hash like SHA-256 is not.
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Long enough to resist offline attack, short enough to fit a passphrase. */
const MIN_LENGTH = 12;
const MAX_LENGTH = 256;

@Injectable()
export class PasswordService {
  /**
   * Rejects passwords that are too short, or long enough to be a denial-of-service
   * vector — Argon2 cost scales with input, so an unbounded password is a way to
   * burn the server's memory budget.
   */
  assertAcceptable(password: string): void {
    if (password.length < MIN_LENGTH) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `Password must be at least ${MIN_LENGTH} characters`,
        { minLength: MIN_LENGTH },
      );
    }
    if (password.length > MAX_LENGTH) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `Password must be at most ${MAX_LENGTH} characters`,
        { maxLength: MAX_LENGTH },
      );
    }
  }

  async hash(password: string): Promise<string> {
    this.assertAcceptable(password);
    return hash(password, ARGON2_OPTIONS);
  }

  /**
   * Verification never throws on a malformed stored hash — it returns false.
   * A corrupt hash must read as "wrong password", not as a 500 that tells an
   * attacker this particular account is interesting.
   */
  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password, ARGON2_OPTIONS);
    } catch {
      return false;
    }
  }
}
