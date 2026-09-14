import { describe, expect, it } from 'vitest';
import { MAX_WINDOW_DAYS, explainWindow, readWindow } from './window';

const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

describe('readWindow', () => {
  it('accepts an ordinary window', () => {
    const result = readWindow(day(-30), day(0), NOW);
    expect('window' in result).toBe(true);
  });

  it.each([
    ['from', 'not a date', day(0)],
    ['to', day(-1), 'also not a date'],
  ])('refuses a %s that is not a date', (which, from, to) => {
    const result = readWindow(from, to, NOW);
    expect(result).toEqual({ problem: { kind: 'not-a-date', which } });
  });

  it('refuses a window that ends before it starts', () => {
    expect(readWindow(day(0), day(-1), NOW)).toEqual({ problem: { kind: 'backwards' } });
  });

  it('refuses a window with no width', () => {
    // Equal ends are not "one instant", they are a mistake — and a report of
    // nothing is better refused than produced.
    expect(readWindow(day(0), day(0), NOW)).toEqual({ problem: { kind: 'backwards' } });
  });

  it(`refuses more than ${MAX_WINDOW_DAYS} days`, () => {
    const result = readWindow(day(-MAX_WINDOW_DAYS - 1), day(0), NOW);
    expect(result).toEqual({ problem: { kind: 'too-wide', days: MAX_WINDOW_DAYS + 1 } });
  });

  it('accepts exactly the cap', () => {
    // Off-by-one on a limit somebody will sit exactly on: a tax year.
    expect('window' in readWindow(day(-MAX_WINDOW_DAYS), day(0), NOW)).toBe(true);
  });

  /**
   * The timezone case, which is the one that would have produced a bug report
   * rather than a test failure.
   */
  it('tolerates a client a few hours ahead asking for "to the end of today"', () => {
    const ahead = new Date(NOW + 11 * 3_600_000).toISOString();
    expect('window' in readWindow(day(-7), ahead, NOW)).toBe(true);
  });

  it('still refuses a window that starts well after now', () => {
    const result = readWindow(day(30), day(31), NOW);
    expect(result).toEqual({ problem: { kind: 'in-the-future' } });
  });
});

describe('explainWindow', () => {
  it('says something an operator can act on for every problem', () => {
    const problems = [
      { kind: 'not-a-date', which: 'from' },
      { kind: 'backwards' },
      { kind: 'too-wide', days: 400 },
      { kind: 'in-the-future' },
    ] as const;
    for (const problem of problems) {
      const words = explainWindow(problem);
      expect(words.length).toBeGreaterThan(10);
      expect(words).toMatch(/\.$/);
    }
    expect(explainWindow({ kind: 'too-wide', days: 400 })).toContain('400');
  });
});
