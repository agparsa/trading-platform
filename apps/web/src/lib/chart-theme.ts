import { LevelKind } from './chart-levels';

/**
 * The chart's colours, read from the theme rather than written twice.
 *
 * The chart library draws on a canvas and takes colours as strings; it cannot
 * see a stylesheet. These were hex literals copied from `globals.css`, which
 * meant a light page with a dark chart's grid on it. Now they are the theme's
 * own variables, read when the chart is made and again whenever the theme
 * changes — and the fallbacks are the dark theme, for a render with no
 * document (a test, the server).
 */
export interface ChartPalette {
  readonly text: string;
  readonly grid: string;
  readonly up: string;
  readonly down: string;
  readonly pending: string;
  readonly entry: string;
}

export const DARK_FALLBACK: ChartPalette = {
  text: '#8b94a3',
  grid: '#232a35',
  up: '#26a69a',
  down: '#ef5350',
  pending: '#f0b90b',
  entry: '#8b94a3',
};

export function chartPalette(read: (variable: string) => string): ChartPalette {
  const colour = (variable: string, fallback: string): string => {
    const value = read(variable).trim();
    return value === '' ? fallback : value;
  };
  const muted = colour('--color-terminal-muted', DARK_FALLBACK.text);
  return {
    text: muted,
    grid: colour('--color-terminal-border', DARK_FALLBACK.grid),
    up: colour('--color-terminal-long', DARK_FALLBACK.up),
    down: colour('--color-terminal-short', DARK_FALLBACK.down),
    pending: colour('--color-terminal-warning', DARK_FALLBACK.pending),
    entry: muted,
  };
}

/** The palette of the page as it is now. */
export function documentPalette(): ChartPalette {
  if (typeof document === 'undefined') return DARK_FALLBACK;
  const style = getComputedStyle(document.documentElement);
  return chartPalette((variable) => style.getPropertyValue(variable));
}

/** Each kind of line in its colour: a stop red, a target green, a resting order amber. */
export function levelColour(kind: LevelKind, palette: ChartPalette): string {
  switch (kind) {
    case LevelKind.STOP_LOSS:
      return palette.down;
    case LevelKind.TAKE_PROFIT:
      return palette.up;
    case LevelKind.PENDING:
      return palette.pending;
    default:
      return palette.entry;
  }
}
