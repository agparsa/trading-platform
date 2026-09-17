import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { PasswordService } from './password.service';
import { envSchema } from '../config/env.schema';

/**
 * The Argon2 cost, which `.env.example` invited operators to tune and nothing
 * read.
 *
 * `PASSWORD_HASH_MEMORY_COST` and `PASSWORD_HASH_TIME_COST` sat in the security
 * block directly under `SECRET_ENCRYPTION_KEYS`, with plausible OWASP values,
 * and existed nowhere else in the repository. Raising the iteration count and
 * restarting changed nothing, and nothing said so — a name no schema knows is a
 * name nothing rejects.
 */
function serviceWith(memoryCost: number, timeCost: number): PasswordService {
  return new PasswordService(
    new ConfigService({
      PASSWORD_HASH_MEMORY_COST: memoryCost,
      PASSWORD_HASH_TIME_COST: timeCost,
    } as never) as never,
  );
}

const PASSWORD = 'correct horse battery staple';

describe('password hashing cost', () => {
  it('hashes at the configured cost, which the hash itself records', async () => {
    const stored = await serviceWith(19_456, 2).hash(PASSWORD);
    expect(stored).toContain('$argon2id$');
    expect(stored).toContain('m=19456,t=2,p=1');

    const harder = await serviceWith(32_768, 4).hash(PASSWORD);
    expect(harder).toContain('m=32768,t=4,p=1');
  });

  /**
   * The reason this was safe to make configurable, measured rather than
   * assumed: Argon2 encodes `m`, `t` and `p` in the hash string and the library
   * reads them from there. Getting this wrong would have locked out every
   * existing user the first time an operator tuned the cost.
   */
  it('verifies a password stored under the old cost after the cost is raised', async () => {
    const stored = await serviceWith(19_456, 2).hash(PASSWORD);

    const raised = serviceWith(32_768, 4);
    expect(await raised.verify(stored, PASSWORD)).toBe(true);
    expect(await raised.verify(stored, 'not the password')).toBe(false);

    // And the other direction, for an instance rolled back mid-deploy.
    const newer = await raised.hash(PASSWORD);
    expect(await serviceWith(19_456, 2).verify(newer, PASSWORD)).toBe(true);
  });

  /**
   * A knob that can quietly weaken password hashing is worse than a fixed cost:
   * the deployment that set it to 1 looks exactly like the one that tuned it
   * properly.
   */
  it('refuses a cost below the OWASP baseline, rather than accepting a weaker one', () => {
    const shape = (envSchema as unknown as { shape: Record<string, { safeParse(value: unknown): { success: boolean } }> })
      .shape;

    expect(shape['PASSWORD_HASH_MEMORY_COST']?.safeParse(1024).success).toBe(false);
    expect(shape['PASSWORD_HASH_MEMORY_COST']?.safeParse(19_456).success).toBe(true);
    expect(shape['PASSWORD_HASH_TIME_COST']?.safeParse(1).success).toBe(false);
    expect(shape['PASSWORD_HASH_TIME_COST']?.safeParse(2).success).toBe(true);
    // And a ceiling, because Argon2 holds its memory for the whole hash and
    // sign-ins arrive together.
    expect(shape['PASSWORD_HASH_MEMORY_COST']?.safeParse(4_194_304).success).toBe(false);
  });

  it('defaults to the OWASP baseline when nothing is set', () => {
    const shape = (envSchema as unknown as { shape: Record<string, { parse(value: unknown): unknown }> })
      .shape;
    expect(shape['PASSWORD_HASH_MEMORY_COST']?.parse(undefined)).toBe(19_456);
    expect(shape['PASSWORD_HASH_TIME_COST']?.parse(undefined)).toBe(2);
  });
});
