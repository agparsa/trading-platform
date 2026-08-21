import { describe, expect, it } from 'vitest';
import { validateEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://trading:pw@localhost:5432/trading_platform',
  REDIS_URL: 'redis://localhost:6379',
};

describe('worker env', () => {
  it('accepts a valid environment', () => {
    expect(validateEnv(base).TRADING_SERVER_TIMEZONE).toBe('UTC');
  });

  it('refuses to start without Redis', () => {
    const { REDIS_URL: _omitted, ...withoutRedis } = base;
    expect(() => validateEnv(withoutRedis)).toThrow(/REDIS_URL/);
  });
});
