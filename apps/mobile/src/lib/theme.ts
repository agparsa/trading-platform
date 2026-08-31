/**
 * One palette, dark by default.
 *
 * A trading terminal is looked at for hours, often in a dim room, and every
 * professional one is dark for that reason. The colours below are the web
 * terminal's, so a trader moving between the two is not relearning what green
 * means.
 */
export const theme = {
  colors: {
    background: '#0B0E11',
    surface: '#151A21',
    surfaceRaised: '#1C232C',
    border: '#252D38',
    text: '#E6EAF0',
    textMuted: '#8A94A6',
    /** Up, profit, buy. */
    positive: '#16C784',
    /** Down, loss, sell. */
    negative: '#EA3943',
    warning: '#F0A70A',
    accent: '#3B82F6',
  },
  spacing: (units: number) => units * 8,
  radius: { sm: 6, md: 10, lg: 16 },
  font: {
    /** Prices and P&L. Tabular figures stop the numbers dancing as they tick. */
    mono: 'monospace',
  },
} as const;

/** Colour for a signed number: green above zero, red below, muted at zero. */
export function signColor(value: string | number): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) return theme.colors.textMuted;
  return numeric > 0 ? theme.colors.positive : theme.colors.negative;
}

/**
 * Formats a signed money amount for display.
 *
 * A leading `+` on a profit, because on a small screen the sign is most of the
 * message. Never rounds: the string arrives from the server as an exact decimal
 * and reformatting it in JavaScript is where money loses precision.
 */
export function formatSigned(value: string): string {
  if (value.startsWith('-')) return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric === 0) return value;
  return `+${value}`;
}
