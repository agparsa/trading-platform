import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { TradingErrorCode } from '@tp/shared-types';
import { withTenant } from '@tp/tenancy';
import type { RedisService } from '../redis/redis.service';
import { TradingThrottle } from './trading-throttle.service';

function build(limits: { account: number; tenant: number }, failing = false) {
  const counters = new Map<string, number>();
  const redis = {
    client: {
      incr: async (key: string) => {
        if (failing) throw new Error('Redis is away');
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return next;
      },
      expire: async () => 1,
    },
  } as unknown as RedisService;
  const config = new ConfigService<Record<string, unknown>, true>({
    ORDER_RATE_LIMIT_PER_ACCOUNT_PER_MINUTE: limits.account,
    ORDER_RATE_LIMIT_PER_TENANT_PER_MINUTE: limits.tenant,
  } as never);
  return { throttle: new TradingThrottle(redis, config as never), counters };
}

const T1 = { tenantId: '00000000-0000-4000-8000-0000000000a1', slug: 'a' };
const T2 = { tenantId: '00000000-0000-4000-8000-0000000000b2', slug: 'b' };
const at = new Date('2026-09-03T10:00:30Z');

describe('TradingThrottle', () => {
  it('counts per account and refuses the action over the ceiling, naming the scope', async () => {
    const { throttle } = build({ account: 2, tenant: 100 });
    await withTenant(T1, async () => {
      await throttle.assertAllowed('acc-1', at);
      await throttle.assertAllowed('acc-1', at);
      await expect(throttle.assertAllowed('acc-1', at)).rejects.toMatchObject({
        code: TradingErrorCode.RATE_LIMITED,
        details: { scope: 'account' },
      });
      // Another account in the same tenant is not affected.
      await throttle.assertAllowed('acc-2', at);
    });
  });

  it('counts per tenant across accounts, and one tenant does not spend another’s', async () => {
    const { throttle } = build({ account: 100, tenant: 3 });
    await withTenant(T1, async () => {
      await throttle.assertAllowed('a', at);
      await throttle.assertAllowed('b', at);
      await throttle.assertAllowed('c', at);
      await expect(throttle.assertAllowed('d', at)).rejects.toMatchObject({
        code: TradingErrorCode.RATE_LIMITED,
        details: { scope: 'tenant' },
      });
    });
    await withTenant(T2, () => throttle.assertAllowed('e', at));
  });

  it('starts a new window each minute', async () => {
    const { throttle } = build({ account: 1, tenant: 100 });
    await withTenant(T1, async () => {
      await throttle.assertAllowed('acc', at);
      await expect(throttle.assertAllowed('acc', at)).rejects.toMatchObject({
        code: TradingErrorCode.RATE_LIMITED,
      });
      await throttle.assertAllowed('acc', new Date(at.getTime() + 60_000));
    });
  });

  it('allows, and does not throw, when Redis cannot answer', async () => {
    const { throttle } = build({ account: 1, tenant: 1 }, true);
    await withTenant(T1, async () => {
      await throttle.assertAllowed('acc', at);
      await throttle.assertAllowed('acc', at);
    });
  });

  it('refuses to count outside a tenant: a limit with no owner is no limit', async () => {
    const { throttle } = build({ account: 1, tenant: 1 });
    await expect(throttle.assertAllowed('acc', at)).rejects.toThrow(/tenant/i);
  });
});
