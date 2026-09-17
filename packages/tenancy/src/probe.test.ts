import { describe, expect, it } from 'vitest';
import {
  ISOLATION_REPROBE_MS,
  probeTenantIsolation,
  shouldReprobe,
  type IsolationState,
  type RawQueryable,
} from './probe';

/**
 * The isolation probe, and the thing it never did with its own answer.
 *
 * It is careful about the one case that matters: reading zero rows from an
 * empty table proves nothing, so it reports `unknown` rather than success. That
 * reasoning is right and had no follow-through — it ran once, at boot, and the
 * table it reads is empty at exactly one moment: a fresh install starting for
 * the first time.
 */

/** A scripted database. `seen` is what the unprivileged role reads. */
function database(
  seen: Array<{ role: string; visible: number }>,
  total: number,
): { unscoped: RawQueryable; privileged: RawQueryable; calls: () => number } {
  let calls = 0;
  let index = 0;
  return {
    calls: () => calls,
    unscoped: {
      $queryRawUnsafe: async <T,>(): Promise<T> => {
        calls += 1;
        const answer = seen[Math.min(index, seen.length - 1)];
        index += 1;
        return [answer] as unknown as T;
      },
    },
    privileged: {
      $queryRawUnsafe: async <T,>(): Promise<T> => [{ total }] as unknown as T,
    },
  };
}

describe('probeTenantIsolation', () => {
  it('reports enforcement when a role that can see nothing is looking at a table with rows', async () => {
    const db = database([{ role: 'trading_app', visible: 0 }], 12);
    expect(await probeTenantIsolation(db.unscoped, db.privileged)).toEqual({
      enforced: true,
      role: 'trading_app',
    });
  });

  it('reports no enforcement when the role reads rows with no tenant bound', async () => {
    const db = database([{ role: 'trading', visible: 12 }], 12);
    const state = await probeTenantIsolation(db.unscoped, db.privileged);
    expect(state.enforced).toBe(false);
    expect(state.role).toBe('trading');
  });

  /**
   * The defect, as a test. Zero rows read from an empty table is the answer a
   * brand-new deployment gets, and it is indistinguishable from enforcement
   * until somebody registers.
   */
  it('reports unknown on an empty table, because zero of zero proves nothing', async () => {
    const db = database([{ role: 'trading_app', visible: 0 }], 0);
    const state = await probeTenantIsolation(db.unscoped, db.privileged);
    expect(state.enforced).toBe('unknown');
    expect(state).toHaveProperty('reason', expect.stringContaining('empty'));
  });

  it('reports unknown rather than a verdict when the query fails', async () => {
    const broken: RawQueryable = {
      $queryRawUnsafe: async () => {
        throw new Error('connection refused');
      },
    };
    const state = await probeTenantIsolation(broken, broken);
    expect(state.enforced).toBe('unknown');
  });

  /**
   * The follow-through: the same deployment, asked again once a row exists,
   * gives a definite answer. Nothing asked it.
   */
  it('answers definitely once the table has a row, on the same connection', async () => {
    const db = database(
      [
        { role: 'trading_app', visible: 0 },
        { role: 'trading_app', visible: 0 },
      ],
      0,
    );
    expect((await probeTenantIsolation(db.unscoped, db.privileged)).enforced).toBe('unknown');

    const populated = database([{ role: 'trading_app', visible: 0 }], 3);
    expect((await probeTenantIsolation(populated.unscoped, populated.privileged)).enforced).toBe(
      true,
    );
  });
});

describe('shouldReprobe', () => {
  const unknown: IsolationState = { enforced: 'unknown', role: 'r', reason: 'empty' };
  const enforced: IsolationState = { enforced: true, role: 'r' };
  const absent: IsolationState = { enforced: false, role: 'r', reason: 'owner' };

  it('asks again while the answer is unknown', () => {
    expect(shouldReprobe(unknown, 0, ISOLATION_REPROBE_MS)).toBe(true);
  });

  it('stops asking once the answer is definite, either way', () => {
    expect(shouldReprobe(enforced, 0, 10 * ISOLATION_REPROBE_MS)).toBe(false);
    expect(shouldReprobe(absent, 0, 10 * ISOLATION_REPROBE_MS)).toBe(false);
  });

  /**
   * Without the floor a health poll becomes a query per request, on the same
   * pool the trading path uses, for a question whose answer cannot change until
   * somebody inserts a row.
   */
  it('does not ask again before the floor has passed', () => {
    expect(shouldReprobe(unknown, 0, ISOLATION_REPROBE_MS - 1)).toBe(false);
    expect(shouldReprobe(unknown, 1_000, 1_000 + ISOLATION_REPROBE_MS)).toBe(true);
  });
});
