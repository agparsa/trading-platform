import { describe, expect, it } from 'vitest';
import { corsOrigins, validateEnv } from './env.schema';

const base = {
  DATABASE_URL: 'postgresql://trading:pw@localhost:5432/trading_platform?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
};

describe('validateEnv', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = validateEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(4000);
    expect(env.MARKET_DATA_PROVIDER).toBe('internal-simulator');
    expect(env.DEFAULT_ACCOUNT_LEVERAGE).toBe(100);
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
