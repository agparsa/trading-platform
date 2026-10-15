import { describe, expect, it } from 'vitest';
import { LevelKind } from './chart-levels';
import { DARK_FALLBACK, chartPalette, levelColour } from './chart-theme';

describe('the chart palette', () => {
  it('takes every colour from the theme', () => {
    const light: Record<string, string> = {
      '--color-terminal-muted': ' #556070',
      '--color-terminal-border': '#d3d9e1',
      '--color-terminal-long': '#0a7368',
      '--color-terminal-short': '#c0282d',
      '--color-terminal-warning': '#855600',
    };
    expect(chartPalette((name) => light[name] ?? '')).toEqual({
      text: '#556070',
      grid: '#d3d9e1',
      up: '#0a7368',
      down: '#c0282d',
      pending: '#855600',
      entry: '#556070',
    });
  });

  it('is the dark theme when there is no stylesheet to read', () => {
    expect(chartPalette(() => '')).toEqual(DARK_FALLBACK);
  });

  it('colours each kind of line', () => {
    expect(levelColour(LevelKind.STOP_LOSS, DARK_FALLBACK)).toBe(DARK_FALLBACK.down);
    expect(levelColour(LevelKind.TAKE_PROFIT, DARK_FALLBACK)).toBe(DARK_FALLBACK.up);
    expect(levelColour(LevelKind.PENDING, DARK_FALLBACK)).toBe(DARK_FALLBACK.pending);
    expect(levelColour(LevelKind.ENTRY, DARK_FALLBACK)).toBe(DARK_FALLBACK.entry);
  });
});
