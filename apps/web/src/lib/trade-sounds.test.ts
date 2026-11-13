import { describe, expect, it } from 'vitest';
import { PlayedOnce, SCORES, gainFor } from './trade-sounds';

describe('trade sounds', () => {
  it('plays an event once, however many times it arrives', () => {
    const once = new PlayedOnce(3);
    expect(once.first('trade_opened:p1')).toBe(true);
    expect(once.first('trade_opened:p1')).toBe(false);
    expect(once.first('trade_closed:p1')).toBe(true);
  });

  it('forgets the oldest past its limit rather than growing for ever', () => {
    const once = new PlayedOnce(2);
    once.first('a');
    once.first('b');
    once.first('c');
    expect(once.first('a')).toBe(true);
    expect(once.first('c')).toBe(false);
  });

  it('is silent at zero and never louder than the ceiling', () => {
    expect(gainFor(0)).toBe(0);
    expect(gainFor(100)).toBeCloseTo(0.35);
    expect(gainFor(250)).toBeCloseTo(0.35);
    expect(gainFor(50)).toBeLessThan(gainFor(100) / 2);
  });

  it('gives every outcome a distinct, short sound', () => {
    const shapes = Object.values(SCORES).map((notes) =>
      notes.map((note) => `${note.hz}/${note.wave}`).join(' '),
    );
    expect(new Set(shapes).size).toBe(shapes.length);
    for (const notes of Object.values(SCORES)) {
      const end = Math.max(...notes.map((note) => note.at + note.length));
      expect(end).toBeLessThanOrEqual(0.6);
    }
  });
});
