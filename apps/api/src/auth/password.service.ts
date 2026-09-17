import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import type { Env } from '../config/env.schema';

/**
 * Password hashing.
 *
 * Argon2id. Memory hardness is the point — it is what makes a leaked hash
 * expensive to attack on GPUs, which a fast hash like SHA-256 is not.
 *
 * The cost defaults to OWASP's baseline (19 MiB, two iterations, one lane) and
 * is tunable per deployment, because the right figure depends on the hardware.
 * `PASSWORD_HASH_MEMORY_COST` and `PASSWORD_HASH_TIME_COST` were printed in
 * `.env.example` long before anything read them; the schema bounds them and
 * refuses anything below the baseline.
 */
const PARALLELISM = 1;

/** Long enough to resist offline attack, short enough to fit a passphrase. */
const MIN_LENGTH = 12;
const MAX_LENGTH = 256;

@Injectable()
export class PasswordService {
  private readonly options: {
    readonly algorithm: Algorithm;
    readonly memoryCost: number;
    readonly timeCost: number;
    readonly parallelism: number;
  };

  /**
   * No `@Inject(ConfigService)`: Nest resolves this from the emitted parameter
   * type, and `scripts/smoke-api.ts` constructs this service directly under
   * `tsx`, which refuses a parameter decorator. `CryptoModule` takes its config
   * the same way. Found by the smoke gate, not by a typecheck.
   */
  constructor(config: ConfigService<Env, true>) {
    this.options = {
      algorithm: Algorithm.Argon2id,
      memoryCost: config.get('PASSWORD_HASH_MEMORY_COST', { infer: true }),
      timeCost: config.get('PASSWORD_HASH_TIME_COST', { infer: true }),
      parallelism: PARALLELISM,
    };
  }

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
    return hash(password, this.options);
  }

  /**
   * Verification never throws on a malformed stored hash — it returns false.
   * A corrupt hash must read as "wrong password", not as a 500 that tells an
   * attacker this particular account is interesting.
   *
   * **The cost here is not what verifies the hash.** Argon2 encodes `m`, `t`
   * and `p` in the hash string, and the library reads them from there — which
   * is why raising the configured cost does not lock out a single existing
   * password. Measured before this was made configurable, because getting it
   * wrong would have locked out every user the first time an operator tuned it.
   * The options are still passed so the algorithm and any future secret stay in
   * one place.
   */
  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password, this.options);
    } catch {
      return false;
    }
  }
}
