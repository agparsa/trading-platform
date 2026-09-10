import { describe, expect, it } from 'vitest';
import {
  connectionBudget,
  connectionLimitOf,
  defaultConnectionLimit,
  describeConnectionBudget,
} from './connection-budget';

describe('connectionLimitOf', () => {
  it('reads connection_limit from the URL', () => {
    expect(connectionLimitOf('postgresql://u:p@h:5432/db?schema=public&connection_limit=8')).toBe(
      8,
    );
    expect(connectionLimitOf('postgresql://u:p@h:5432/db?connection_limit=25&schema=public')).toBe(
      25,
    );
  });

  it("falls back to Prisma's default when the URL does not say, or says nonsense", () => {
    expect(connectionLimitOf('postgresql://u:p@h:5432/db', 2)).toBe(5);
    expect(connectionLimitOf('postgresql://u:p@h:5432/db?schema=public', 4)).toBe(9);
    expect(connectionLimitOf('postgresql://u:p@h:5432/db?connection_limit=0', 2)).toBe(5);
    expect(connectionLimitOf('postgresql://u:p@h:5432/db?connection_limit=many', 2)).toBe(5);
    expect(defaultConnectionLimit(8)).toBe(17);
  });
});

describe('connectionBudget', () => {
  /**
   * The case the load harness hit: 32 pools × 5, two instances, a stock
   * Postgres. 340 asked of 97.
   */
  it('says when one instance alone exceeds the server', () => {
    const budget = connectionBudget(
      { tenantPools: 32, tenantConnectionLimit: 5, privilegedConnectionLimit: 5 },
      { maxConnections: 100, reserved: 3 },
    );
    expect(budget.perInstance).toBe(33 * 5 + 5);
    expect(budget.available).toBe(97);
    expect(budget.fits).toBe(false);
    expect(budget.instancesThatFit).toBe(0);
    expect(
      describeConnectionBudget(budget, {
        tenantPools: 32,
        tenantConnectionLimit: 5,
        privilegedConnectionLimit: 5,
      }),
    ).toMatch(/does not fit even one instance/);
  });

  it('counts how many instances fit side by side', () => {
    const input = { tenantPools: 4, tenantConnectionLimit: 8, privilegedConnectionLimit: 8 };
    const budget = connectionBudget(input, { maxConnections: 100, reserved: 3 });
    expect(budget.perInstance).toBe(5 * 8 + 8);
    expect(budget.instancesThatFit).toBe(2);
    expect(budget.fits).toBe(true);
    expect(describeConnectionBudget(budget, input)).toMatch(/2 such instance\(s\) fit/);
  });

  it('warns in words when exactly one fits, because production runs more than one process', () => {
    const input = { tenantPools: 8, tenantConnectionLimit: 5, privilegedConnectionLimit: 5 };
    const budget = connectionBudget(input, { maxConnections: 100, reserved: 3 });
    expect(budget.perInstance).toBe(50);
    expect(budget.instancesThatFit).toBe(1);
    expect(describeConnectionBudget(budget, input)).toMatch(/second instance, the worker/);
  });

  it('never reports negative capacity', () => {
    const budget = connectionBudget(
      { tenantPools: 1, tenantConnectionLimit: 1, privilegedConnectionLimit: 1 },
      { maxConnections: 2, reserved: 3 },
    );
    expect(budget.available).toBe(0);
    expect(budget.fits).toBe(false);
  });
});
