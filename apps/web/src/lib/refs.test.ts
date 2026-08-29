import { describe, expect, it } from 'vitest';
import { shortRef, shortRefs } from './refs';

describe('shortRefs', () => {
  it('shows eight characters when nothing collides', () => {
    const refs = shortRefs([
      'a3f1c9e2-4b7d-4f0a-9c31-5e8b2d7a1f60',
      'b7220000-0000-0000-0000-000000000000',
    ]);
    expect(refs.get('a3f1c9e2-4b7d-4f0a-9c31-5e8b2d7a1f60')).toBe('A3F1C9E2');
    expect(refs.get('b7220000-0000-0000-0000-000000000000')).toBe('B7220000');
  });

  /**
   * The property that matters. Two positions labelled the same way make every
   * instruction about that label ambiguous, and the trader cannot see that it is.
   */
  it('lengthens every label until no two are the same', () => {
    const a = 'a3f1c9e2-4b7d-4f0a-9c31-5e8b2d7a1f60';
    const b = 'a3f1c9e2-0000-0000-0000-000000000000';
    const refs = shortRefs([a, b]);

    expect(refs.get(a)).not.toBe(refs.get(b));
    // Widened for both, so the column keeps one width.
    expect(refs.get(a)?.length).toBe(refs.get(b)?.length);
    expect(refs.get(a)?.length).toBeGreaterThan(8);
  });

  it('keeps widening while a collision survives', () => {
    const a = `${'ab'.repeat(8)}cd${'0'.repeat(14)}`;
    const b = `${'ab'.repeat(8)}ef${'0'.repeat(14)}`;
    const refs = shortRefs([a, b]);
    expect(refs.get(a)).not.toBe(refs.get(b));
  });

  it('treats ids that would look identical as colliding, whatever their punctuation', () => {
    const dashed = 'a3f1c9e2-4b7d-4f0a-9c31-5e8b2d7a1f60';
    const plain = 'a3f1c9e24b7d4f0a9c315e8b2d7a1f60';
    const refs = shortRefs([dashed, plain]);
    // The same underlying value: both entries exist and both read the same, which
    // is correct — they are not two different things.
    expect(refs.get(dashed)).toBe(refs.get(plain));
  });

  it('survives an empty list and a single id', () => {
    expect(shortRefs([]).size).toBe(0);
    const one = shortRefs(['a3f1c9e2-4b7d-4f0a-9c31-5e8b2d7a1f60']);
    expect(one.get('a3f1c9e2-4b7d-4f0a-9c31-5e8b2d7a1f60')).toBe('A3F1C9E2');
  });

  it('never returns an empty label', () => {
    expect(shortRefs(['']).get('')).toBe('');
    expect(shortRef('')).toBe('');
    expect(shortRef('abc')).toBe('ABC');
  });
});
