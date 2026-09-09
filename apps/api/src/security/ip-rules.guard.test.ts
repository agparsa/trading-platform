import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { DomainError, UserRole } from '@tp/shared-types';
import { IpRulesGuard } from './ip-rules.guard';
import type { IpRulesService } from './ip-rules.service';
import type { IpRule } from './ip-rules';

/**
 * The guard's own decisions (§46).
 *
 * The matching is proved in `ip-rules.test.ts`; what is proved here is the
 * three things the guard alone decides: that an unauthenticated request is
 * never refused, that a customer is judged by a different rule set than a
 * member of staff, and — the one that matters most — that a deployment which
 * cannot see real client addresses lets everybody through and says so, rather
 * than enforcing an allow-list against a proxy.
 */

const context = (
  user: { id: string; role: UserRole } | undefined,
  ip: string,
  headers: Record<string, string> = {},
  isPublic = false,
): { context: ExecutionContext; reflector: { getAllAndOverride: () => boolean } } => {
  const request = {
    ip,
    user,
    header: (name: string) => headers[name.toLowerCase()],
  };
  return {
    context: {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext,
    reflector: { getAllAndOverride: () => isPublic },
  };
};

const rules = (active: readonly IpRule[], decide?: IpRulesService['decide']) =>
  ({
    active: async () => active,
    decide:
      decide ??
      (async (address: string) => ({ allowed: address.startsWith('203.0.113.'), reason: 'x' })),
  }) as unknown as IpRulesService;

const config = (hops: number | undefined) => ({ get: () => hops }) as never;

const staff = { id: 'u1', role: UserRole.ADMIN };
const trader = { id: 'u2', role: UserRole.USER };

const ALLOW_OFFICE: readonly IpRule[] = [{ cidr: '203.0.113.0/24', kind: 'ALLOW', scope: 'STAFF' }];

describe('IpRulesGuard', () => {
  it('lets an unauthenticated request through — the sign-in page must stay reachable', async () => {
    const { context: ctx, reflector } = context(undefined, '198.51.100.9');
    const guard = new IpRulesGuard(reflector as never, rules(ALLOW_OFFICE), config(0));
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('lets a public route through without consulting the rules', async () => {
    const consulted = vi.fn(async () => ALLOW_OFFICE);
    const { context: ctx, reflector } = context(staff, '198.51.100.9', {}, true);
    const guard = new IpRulesGuard(
      reflector as never,
      { active: consulted } as unknown as IpRulesService,
      config(0),
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(consulted).not.toHaveBeenCalled();
  });

  it('lets everybody through when the firm has written no rules', async () => {
    const { context: ctx, reflector } = context(staff, '198.51.100.9');
    const guard = new IpRulesGuard(reflector as never, rules([]), config(0));
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('admits an address the rules allow', async () => {
    const { context: ctx, reflector } = context(staff, '203.0.113.5');
    const guard = new IpRulesGuard(reflector as never, rules(ALLOW_OFFICE), config(0));
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('refuses an address the rules exclude', async () => {
    const { context: ctx, reflector } = context(staff, '198.51.100.9');
    const guard = new IpRulesGuard(reflector as never, rules(ALLOW_OFFICE), config(0));
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(DomainError);
  });

  /**
   * The refusal names the caller's own address and nothing else. Somebody being
   * kept out does not get to map the allow-list by probing it; somebody
   * legitimately locked out needs exactly one fact to tell their administrator.
   */
  it('tells the caller their address and nothing about the rules', async () => {
    const { context: ctx, reflector } = context(staff, '198.51.100.9');
    const guard = new IpRulesGuard(reflector as never, rules(ALLOW_OFFICE), config(0));
    const error = await guard.canActivate(ctx).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainError);
    const message = (error as DomainError).message;
    expect(message).toContain('198.51.100.9');
    expect(message).not.toContain('203.0.113');
  });

  /** A customer is judged by `EVERYONE`; a member of staff by `STAFF`. */
  it('judges a customer and a member of staff by different scopes', async () => {
    const seen: string[] = [];
    const spy = rules(ALLOW_OFFICE, (async (_address: string, scope: string) => {
      seen.push(scope);
      return { allowed: true } as never;
    }) as never);

    const asStaff = context(staff, '203.0.113.5');
    await new IpRulesGuard(asStaff.reflector as never, spy, config(0)).canActivate(asStaff.context);
    const asTrader = context(trader, '203.0.113.5');
    await new IpRulesGuard(asTrader.reflector as never, spy, config(0)).canActivate(
      asTrader.context,
    );

    expect(seen).toEqual(['STAFF', 'EVERYONE']);
  });

  /**
   * The fail-open case, and the reason for it: refusing everybody when the
   * platform cannot tell who they are locks out the person who would fix the
   * misconfiguration, permanently, with no route back.
   *
   * It has to be loud. A control that is off and looks on is worse than one
   * that is plainly off.
   */
  it('enforces nothing while the deployment has not said what is in front of it', async () => {
    const spoken = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const guard = new IpRulesGuard(
        { getAllAndOverride: () => false } as never,
        rules(ALLOW_OFFICE),
        config(undefined),
      );
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { context: ctx } = context(staff, '10.0.0.1', {
          'x-forwarded-for': '198.51.100.9',
        });
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
      }
      expect(spoken).toHaveBeenCalledTimes(1);
      expect(String(spoken.mock.calls[0]?.[1])).toMatch(/TRUSTED_PROXY_HOPS/);
    } finally {
      spoken.mockRestore();
    }
  });

  /**
   * With a proxy declared, the address is taken from the forwarded chain — so a
   * caller cannot escape a DENY by putting a friendly address in the header,
   * and a genuine office address behind the proxy is not read as the proxy's.
   */
  it('judges the forwarded address once a proxy is declared', async () => {
    const allowed = context(staff, '10.0.0.1', { 'x-forwarded-for': '203.0.113.5' });
    await expect(
      new IpRulesGuard(allowed.reflector as never, rules(ALLOW_OFFICE), config(1)).canActivate(
        allowed.context,
      ),
    ).resolves.toBe(true);

    const refused = context(staff, '10.0.0.1', { 'x-forwarded-for': '198.51.100.9' });
    await expect(
      new IpRulesGuard(refused.reflector as never, rules(ALLOW_OFFICE), config(1)).canActivate(
        refused.context,
      ),
    ).rejects.toBeInstanceOf(DomainError);
  });

  /**
   * A chain shorter than the configuration promised means the request did not
   * arrive through the proxies this deployment declared. Falling back to
   * another entry would let a caller who sends a short header choose which one
   * is believed, so nothing is enforced instead.
   */
  it('enforces nothing when the forwarded chain is shorter than promised', async () => {
    const short = context(staff, '10.0.0.1', { 'x-forwarded-for': '198.51.100.9' });
    await expect(
      new IpRulesGuard(short.reflector as never, rules(ALLOW_OFFICE), config(2)).canActivate(
        short.context,
      ),
    ).resolves.toBe(true);
  });

  /**
   * The header a caller controls. With one proxy declared, the trusted entry is
   * the last one — everything to its left was written by whoever called in, so
   * an attacker prepending an office address changes nothing.
   */
  it('cannot be talked past by a forged forwarded chain', async () => {
    const forged = context(staff, '10.0.0.1', {
      'x-forwarded-for': '203.0.113.5, 198.51.100.9',
    });
    await expect(
      new IpRulesGuard(forged.reflector as never, rules(ALLOW_OFFICE), config(1)).canActivate(
        forged.context,
      ),
    ).rejects.toBeInstanceOf(DomainError);
  });
});
