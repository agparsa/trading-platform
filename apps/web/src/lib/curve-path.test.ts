import { describe, expect, it } from 'vitest';
import { curveGeometry } from './curve-path';

describe('equity chart geometry', () => {
  it('puts the highest value at the top and the lowest at the bottom', () => {
    const g = curveGeometry([['100', '200', '150']], 100, 50, 0);
    expect(g?.lines[0]).toBe('M0,50 L50,0 L100,25');
    expect(g?.xs).toEqual([0, 50, 100]);
  });

  it('shares one scale between series so they can be compared', () => {
    const g = curveGeometry(
      [
        ['100', '200'],
        ['100', '100'],
      ],
      100,
      50,
      0,
    );
    expect(g?.lines[1]).toBe('M0,50 L100,50');
  });

  it('centres a flat line and a single point', () => {
    const g = curveGeometry([['10', '10']], 100, 50, 0);
    expect(g?.lines[0]).toBe('M0,25 L100,25');
    expect(curveGeometry([['10']], 100, 50, 0)?.lines[0]).toBe('M50,25');
  });

  it('draws nothing for nothing', () => {
    expect(curveGeometry([], 100, 50)).toBeNull();
    expect(curveGeometry([[]], 100, 50)).toBeNull();
  });

  it('closes the area under the first series', () => {
    expect(curveGeometry([['1', '2']], 100, 50, 0)?.area).toBe('M0,50 L100,0 L100,50 L0,50 Z');
  });
});
