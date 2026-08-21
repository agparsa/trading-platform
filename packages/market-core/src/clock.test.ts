import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock';

describe('ManualClock', () => {
  it('only moves when told to', () => {
    const clock = new ManualClock(1000);
    expect(clock.now()).toBe(1000);
    expect(clock.advance(250)).toBe(1250);
    expect(clock.now()).toBe(1250);
  });

  it('refuses to move backwards', () => {
    const clock = new ManualClock(1000);
    expect(() => clock.advance(-1)).toThrow(RangeError);
  });
});
