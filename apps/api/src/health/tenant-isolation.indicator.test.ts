import { describe, expect, it } from 'vitest';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { IsolationState } from '@tp/tenancy';
import { TenantIsolationHealthIndicator } from './health.indicators';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Four states, and only one of them is a routing decision.
 *
 * Before this, all four were a single line in the boot log — and on the default
 * deployment that line is a warning nobody is meant to act on, which is how a
 * reader learns to skip the line that matters.
 */
function indicatorFor(state: IsolationState, configured: boolean) {
  const prisma = {
    tenantRoleConfigured: configured,
    resolveTenantIsolation: async () => state,
  } as unknown as PrismaService;
  return new TenantIsolationHealthIndicator(new HealthIndicatorService(), prisma);
}

const ENFORCED: IsolationState = { enforced: true, role: 'trading_app' };
const ABSENT: IsolationState = {
  enforced: false,
  role: 'trading',
  reason: 'role trading reads 12 rows from users with no tenant set, so it owns the table',
};
const UNKNOWN: IsolationState = {
  enforced: 'unknown',
  role: 'trading_app',
  reason: 'users is empty, so reading zero rows proves nothing',
};

const detailOf = (result: Record<string, unknown>) =>
  result['tenant-isolation'] as Record<string, unknown>;

describe('tenant isolation health', () => {
  it('is up and says so when the policies apply', async () => {
    const result = await indicatorFor(ENFORCED, true).check();
    expect(detailOf(result)['status']).toBe('up');
    expect(detailOf(result)['enforced']).toBe(true);
  });

  /**
   * The single-role deployment is what `.env.example` ships, and it is a choice
   * its operator made. Reported, not routed on.
   */
  it('is up on the single-role deployment, and still reports that layer two is off', async () => {
    const result = await indicatorFor(ABSENT, false).check();
    expect(detailOf(result)['status']).toBe('up');
    expect(detailOf(result)['enforced']).toBe(false);
    expect(detailOf(result)['configured']).toBe(false);
  });

  /**
   * The promise in docs/multi-tenancy.md — the process refuses to start on this
   * pair — kept by a process that is already running.
   */
  it('is down when isolation was asked for and is not there', async () => {
    const result = await indicatorFor(ABSENT, true).check();
    expect(detailOf(result)['status']).toBe('down');
    expect(detailOf(result)['enforced']).toBe(false);
    expect(detailOf(result)['configured']).toBe(true);
  });

  /**
   * Unknown means the probe table is empty, which on a two-role deployment is a
   * brand-new install. Down here would stop the platform serving the request
   * that creates its first user, so it could never become provable.
   */
  it('is up while the answer is unknown, even when isolation was asked for', async () => {
    const result = await indicatorFor(UNKNOWN, true).check();
    expect(detailOf(result)['status']).toBe('up');
    expect(detailOf(result)['enforced']).toBe('unknown');
  });

  /**
   * `/health/*` is public, as an orchestrator's probe has to be. The role name
   * and the probe's reason are database internals.
   */
  it('publishes no database internals, in any state', async () => {
    for (const [state, configured] of [
      [ENFORCED, true],
      [ABSENT, false],
      [ABSENT, true],
      [UNKNOWN, true],
    ] as const) {
      const printed = JSON.stringify(await indicatorFor(state, configured).check());
      expect(printed, 'the role name reached a public probe').not.toContain('trading_app');
      expect(printed, 'the role name reached a public probe').not.toMatch(/"trading"/);
      expect(printed, 'the probe reason reached a public probe').not.toContain('owns the table');
      expect(printed).not.toContain('proves nothing');
    }
  });
});
