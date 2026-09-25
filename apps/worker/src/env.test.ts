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

  /**
   * The miscount that would not otherwise announce itself.
   *
   * BullMQ's cron parser accepts four fields and leaves day-of-week open, so
   * `0 0 * *` — written by somebody who meant midnight daily — parses cleanly
   * and fires every minute. Swap accrual would charge overnight financing
   * fourteen hundred times a day, and nothing in any log would look wrong.
   */
  it('refuses a four-field cron that would silently fire every minute', () => {
    expect(() => validateEnv({ ...base, SWAP_ACCRUAL_CRON: '0 0 * *' })).toThrow(
      /SWAP_ACCRUAL_CRON/,
    );
    expect(() => validateEnv({ ...base, RECONCILIATION_CRON: 'hourly please' })).toThrow(
      /RECONCILIATION_CRON/,
    );
    expect(validateEnv({ ...base, SWAP_ACCRUAL_CRON: '0 3 * * *' }).SWAP_ACCRUAL_CRON).toBe(
      '0 3 * * *',
    );
  });

  it('takes the reachability probe as a list of addresses, each one checked', () => {
    expect(
      validateEnv({
        ...base,
        EGRESS_PROBE_URL: ' https://mirror.example.org/alpine/ , https://cdn.example.com/ ',
      }).EGRESS_PROBE_URL,
    ).toBe('https://mirror.example.org/alpine/,https://cdn.example.com/');
    expect(() =>
      validateEnv({ ...base, EGRESS_PROBE_URL: 'https://mirror.example.org/,not a url' }),
    ).toThrow(/EGRESS_PROBE_URL/);
    expect(validateEnv({ ...base, EGRESS_PROBE_URL: 'off' }).EGRESS_PROBE_URL).toBe('off');
  });
});
