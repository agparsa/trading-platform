import { describe, expect, it } from 'vitest';
import { SeededRandom } from './random';

describe('SeededRandom', () => {
  it('reproduces the same sequence from the same seed', () => {
    const a = new SeededRandom(20260821);
    const b = new SeededRandom(20260821);
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('produces a different sequence from a different seed', () => {
    const a = new SeededRandom(1);
    const b = new SeededRandom(2);
    expect(a.next()).not.toBe(b.next());
  });

  it('stays within [0, 1)', () => {
    const rng = new SeededRandom(7);
    for (let i = 0; i < 2000; i += 1) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('produces finite normal deviates centred near zero', () => {
    const rng = new SeededRandom(99);
    let sum = 0;
    const n = 5000;
    for (let i = 0; i < n; i += 1) {
      const v = rng.normal();
      expect(Number.isFinite(v)).toBe(true);
      sum += v;
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.1);
  });

  it('rejects a non-integer seed', () => {
    expect(() => new SeededRandom(1.5)).toThrow(TypeError);
  });
});
