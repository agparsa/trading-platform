import { afterEach, describe, expect, it } from 'vitest';
import { corsOrigins, rateLimits, validateEnv } from './env.schema';
import { generateEncryptionKey } from '@tp/crypto-core';

const base = {
  DATABASE_URL: 'postgresql://trading:pw@localhost:5432/trading_platform?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  SECRET_ENCRYPTION_KEYS: generateEncryptionKey('1'),
};

describe('validateEnv', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = validateEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(4000);
    expect(env.MARKET_DATA_PROVIDER).toBe('internal-simulator');
    expect(env.DEFAULT_ACCOUNT_LEVERAGE).toBe(100);
  });

  describe('REGISTRATION_MODE', () => {
    it('defaults to open, because a fresh checkout should let you sign up', () => {
      expect(validateEnv(base).REGISTRATION_MODE).toBe('open');
    });

    it('refuses to boot open in production', () => {
      /**
       * A public hostname that accepts any registration is not a configuration
       * anybody chooses; it is one nobody made. The process refusing to start
       * is the only moment at which somebody is definitely looking.
       */
      expect(() =>
        validateEnv({ ...base, NODE_ENV: 'production', REGISTRATION_MODE: 'open' }),
      ).toThrow(/REGISTRATION_MODE/);
    });

    it('refuses to boot open in production by default, not only when set explicitly', () => {
      // The dangerous case is the one where the variable is absent altogether
      // and the default fills it in.
      expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(/REGISTRATION_MODE/);
    });

    it('allows invite and closed in production', () => {
      for (const mode of ['invite', 'closed'] as const) {
        expect(
          validateEnv({ ...base, NODE_ENV: 'production', REGISTRATION_MODE: mode })
            .REGISTRATION_MODE,
        ).toBe(mode);
      }
    });

    it('allows open in production when somebody says so on purpose', () => {
      const env = validateEnv({
        ...base,
        NODE_ENV: 'production',
        REGISTRATION_MODE: 'open',
        REGISTRATION_ALLOW_OPEN_IN_PRODUCTION: 'true',
      });
      expect(env.REGISTRATION_MODE).toBe('open');
      expect(env.REGISTRATION_ALLOW_OPEN_IN_PRODUCTION).toBe(true);
    });

    it('does not treat any other truthy-looking value as consent', () => {
      // 'yes', '1' and 'TRUE' are what somebody types when they are guessing.
      // Guessing is not consent, and a near miss must refuse rather than open.
      for (const value of ['yes', '1', 'TRUE', 'on']) {
        expect(() =>
          validateEnv({
            ...base,
            NODE_ENV: 'production',
            REGISTRATION_MODE: 'open',
            REGISTRATION_ALLOW_OPEN_IN_PRODUCTION: value,
          }),
        ).toThrow();
      }
    });

    it('leaves staging alone, which is what staging is for', () => {
      expect(
        validateEnv({ ...base, NODE_ENV: 'staging', REGISTRATION_MODE: 'open' }).REGISTRATION_MODE,
      ).toBe('open');
    });

    it('rejects a mode nobody implemented', () => {
      expect(() => validateEnv({ ...base, REGISTRATION_MODE: 'public' })).toThrow(
        /REGISTRATION_MODE/,
      );
    });
  });

  it('refuses to boot on a short JWT secret', () => {
    expect(() => validateEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('refuses to boot without a database URL', () => {
    const { DATABASE_URL: _omitted, ...withoutDb } = base;
    expect(() => validateEnv(withoutDb)).toThrow(/DATABASE_URL/);
  });

  it('rejects a database URL that is not postgres', () => {
    expect(() => validateEnv({ ...base, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('coerces numeric strings from the environment', () => {
    const env = validateEnv({ ...base, API_PORT: '8080', MARKET_SIMULATOR_SEED: '7' });
    expect(env.API_PORT).toBe(8080);
    expect(env.MARKET_SIMULATOR_SEED).toBe(7);
  });

  it('rejects an out-of-range port', () => {
    expect(() => validateEnv({ ...base, API_PORT: '70000' })).toThrow(/API_PORT/);
  });

  describe('SECRET_ENCRYPTION_KEYS', () => {
    it('refuses to boot without one, rather than starting with nothing to encrypt with', () => {
      const { SECRET_ENCRYPTION_KEYS: _omitted, ...withoutKeys } = base;
      expect(() => validateEnv(withoutKeys)).toThrow(/SECRET_ENCRYPTION_KEYS/);
    });

    it('refuses a key of the wrong length', () => {
      expect(() =>
        validateEnv({
          ...base,
          SECRET_ENCRYPTION_KEYS: `1:${Buffer.alloc(16).toString('base64')}`,
        }),
      ).toThrow(/SECRET_ENCRYPTION_KEYS/);
    });

    it('accepts several keys, so a rotation does not need a flag day', () => {
      const keys = `2:${generateEncryptionKey('2').split(':')[1]},1:${generateEncryptionKey('1').split(':')[1]}`;
      expect(validateEnv({ ...base, SECRET_ENCRYPTION_KEYS: keys }).SECRET_ENCRYPTION_KEYS).toBe(
        keys,
      );
    });

    it('never echoes a key in the error message', () => {
      const key = generateEncryptionKey('1');
      try {
        validateEnv({ ...base, SECRET_ENCRYPTION_KEYS: `${key},broken` });
        throw new Error('expected validation to fail');
      } catch (error) {
        expect((error as Error).message).toContain('SECRET_ENCRYPTION_KEYS');
        expect((error as Error).message).not.toContain(key.split(':')[1]);
      }
    });
  });

  it('never echoes a secret value in the error message', () => {
    const secret = 'super-secret-value-that-is-too-short';
    try {
      validateEnv({ ...base, JWT_ACCESS_SECRET: 'x' });
      throw new Error('expected validation to fail');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe('corsOrigins', () => {
  it('splits and trims the allowlist', () => {
    expect(corsOrigins('http://a.test, http://b.test')).toEqual(['http://a.test', 'http://b.test']);
  });

  it('drops empty entries instead of producing a wildcard', () => {
    expect(corsOrigins('http://a.test,,')).toEqual(['http://a.test']);
    expect(corsOrigins('')).toEqual([]);
  });
});

describe('rateLimits', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('falls back to the schema’s defaults when nothing is set', () => {
    delete process.env['RATE_LIMIT_LOGIN_PER_MINUTE'];
    delete process.env['RATE_LIMIT_ORDERS_PER_MINUTE'];
    expect(rateLimits.login).toBe(5);
    expect(rateLimits.orders).toBe(120);
  });

  /**
   * The defect this exists to prevent: `RATE_LIMIT_LOGIN_PER_MINUTE` was
   * declared, documented and read by nothing, while the decorator carried a
   * literal 5. An operator tightening it would have believed they had.
   */
  it('lets an operator actually change the login limit', () => {
    process.env['RATE_LIMIT_LOGIN_PER_MINUTE'] = '3';
    expect(rateLimits.login).toBe(3);
  });

  it('lets an operator actually change the order limit', () => {
    process.env['RATE_LIMIT_ORDERS_PER_MINUTE'] = '600';
    expect(rateLimits.orders).toBe(600);
  });

  /**
   * A malformed value keeps the safe default rather than becoming NaN, which
   * `@nestjs/throttler` would treat as a limit nothing can exceed — a typo would
   * otherwise silently disable the limiter.
   */
  it('ignores a value that is not a positive integer', () => {
    process.env['RATE_LIMIT_LOGIN_PER_MINUTE'] = 'lots';
    expect(rateLimits.login).toBe(5);
    process.env['RATE_LIMIT_LOGIN_PER_MINUTE'] = '0';
    expect(rateLimits.login).toBe(5);
    process.env['RATE_LIMIT_LOGIN_PER_MINUTE'] = '-1';
    expect(rateLimits.login).toBe(5);
  });
});
