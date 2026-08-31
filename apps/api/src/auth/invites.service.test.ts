import { describe, expect, it } from 'vitest';
import { __testing } from './invites.service';

const { generateCode, normaliseCode, hashCode } = __testing;

describe('invite codes', () => {
  it('draws from an alphabet with no character that can be misread', () => {
    /**
     * 0/O and 1/I are the pairs people get wrong retyping a code off a screen,
     * so all four are gone. `L` stays: it is only confusable with `1` and `I`,
     * and neither survives.
     */
    const codes = Array.from({ length: 200 }, () => generateCode()).join('');
    expect(codes).not.toMatch(/[01IO]/);
  });

  it('is long enough that guessing is not an attack', () => {
    // 24 characters from 32 symbols is 120 bits. At a billion guesses a second
    // this outlives the platform, the firm, and the guesser.
    const code = generateCode();
    expect(code).toHaveLength(24);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{24}$/);
    expect(code).not.toMatch(/[IO01]/);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 2_000 }, () => generateCode()));
    expect(seen.size).toBe(2_000);
  });

  it('has no obvious bias across the alphabet', () => {
    /**
     * Not a proof of uniformity — a chi-squared test on 24,000 draws would be a
     * flaky test, and flaky is worse than absent. This catches the failure that
     * actually happens: a modulo that silently makes the first few symbols more
     * likely, or an off-by-one that drops the last symbol entirely.
     */
    const counts = new Map<string, number>();
    for (const ch of Array.from({ length: 1_000 }, () => generateCode()).join('')) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(counts.size).toBe(32);
    const frequencies = [...counts.values()];
    const expected = 24_000 / 32;
    expect(Math.min(...frequencies)).toBeGreaterThan(expected * 0.6);
    expect(Math.max(...frequencies)).toBeLessThan(expected * 1.4);
  });

  it('accepts a code retyped with the spacing and case a human adds', () => {
    const code = generateCode();
    const asTyped = `${code.slice(0, 6)}-${code.slice(6, 12)} ${code.slice(12)}`.toLowerCase();
    expect(normaliseCode(asTyped)).toBe(code);
  });

  it('normalises to nothing when there is nothing to normalise', () => {
    // The service treats an empty normalisation as a refusal rather than
    // matching a row whose hash happens to be the hash of the empty string.
    expect(normaliseCode('   --- ')).toBe('');
  });

  it('hashes deterministically, and differently for different codes', () => {
    const a = generateCode();
    const b = generateCode();
    expect(hashCode(a)).toBe(hashCode(a));
    expect(hashCode(a)).not.toBe(hashCode(b));
    expect(hashCode(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never yields the code back from its hash', () => {
    // Stated as a test because it is the property the whole design rests on:
    // what is stored cannot produce what was shown.
    const code = generateCode();
    expect(hashCode(code)).not.toContain(code);
    expect(hashCode(code)).not.toContain(code.slice(0, 8));
  });
});
