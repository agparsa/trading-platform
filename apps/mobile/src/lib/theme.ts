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
    background: '#07090D',
    surface: '#10141B',
    surfaceRaised: '#181D26',
    /** Inputs and tiles sunk into a card. */
    surfaceSunken: '#0C1016',
    border: '#212835',
    borderStrong: '#2F3847',
    text: '#EEF1F6',
    textMuted: '#8590A3',
    textFaint: '#566074',
    /** Up, buy — a price that rose, a buy button. */
    positive: '#16C784',
    /**
     * Money made: a position in profit, a take-profit line. Blue, so a figure
     * that is up reads as "up" rather than as "a buy" — the web terminal's
     * `--color-terminal-profit`.
     */
    profit: '#38BDF8',
    /** Down, loss, sell. */
    negative: '#EA3943',
    warning: '#F0A70A',
    accent: '#3B82F6',
    /** The sides and the accent at a wash, for tiles and selected states. */
    buyTint: 'rgba(22, 199, 132, 0.14)',
    sellTint: 'rgba(234, 57, 67, 0.14)',
    accentTint: 'rgba(59, 130, 246, 0.16)',
    profitTint: 'rgba(56, 189, 248, 0.14)',
    warningTint: 'rgba(240, 167, 10, 0.14)',
  },
  spacing: (units: number) => units * 8,
  radius: { sm: 8, md: 12, lg: 18, pill: 999 },
  /**
   * Families by weight. Android picks a face by family, not by `fontWeight`,
   * so each weight is its own family and styles name one rather than a
   * weight (see `lib/fonts.ts`).
   */
  font: {
    regular: 'Vazirmatn_400Regular',
    medium: 'Vazirmatn_500Medium',
    semibold: 'Vazirmatn_600SemiBold',
    bold: 'Vazirmatn_700Bold',
    heavy: 'Vazirmatn_800ExtraBold',
    /** Prices and P&L. Tabular figures stop the numbers dancing as they tick. */
    mono: 'JetBrainsMono_500Medium',
    monoBold: 'JetBrainsMono_700Bold',
    monoHeavy: 'JetBrainsMono_800ExtraBold',
  },
} as const;

/** Colour for a signed money figure: blue above zero, red below, muted at zero. */
export function signColor(value: string | number): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) return theme.colors.textMuted;
  return numeric > 0 ? theme.colors.profit : theme.colors.negative;
}

/** Colour for a price change: green up, red down — a market moving, not money made. */
export function changeColor(value: string | number): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) return theme.colors.textMuted;
  return numeric > 0 ? theme.colors.positive : theme.colors.negative;
}

/**
 * Which way a money figure moved, compared as exact decimal strings — never
 * through a double, which can lose the last cent of a large figure. `null`
 * for a first value, an unchanged one, or something that is not a number.
 */
export function moved(before: string | null, after: string | null): 'up' | 'down' | null {
  if (before === null || after === null || before === after) return null;
  const order = compareDecimal(before.trim(), after.trim());
  return order === null || order === 0 ? null : order < 0 ? 'up' : 'down';
}

function compareDecimal(a: string, b: string): number | null {
  const parse = (text: string) => {
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
    if (match === null) return null;
    const whole = (match[2] ?? '0').replace(/^0+(?=\d)/, '');
    const fraction = (match[3] ?? '').replace(/0+$/, '');
    const zero = /^0*$/.test(whole) && fraction === '';
    return { negative: match[1] === '-' && !zero, whole, fraction };
  };
  const x = parse(a);
  const y = parse(b);
  if (x === null || y === null) return null;
  if (x.negative !== y.negative) return x.negative ? -1 : 1;
  const magnitude = (() => {
    if (x.whole.length !== y.whole.length) return x.whole.length < y.whole.length ? -1 : 1;
    if (x.whole !== y.whole) return x.whole < y.whole ? -1 : 1;
    const width = Math.max(x.fraction.length, y.fraction.length);
    const fx = x.fraction.padEnd(width, '0');
    const fy = y.fraction.padEnd(width, '0');
    return fx === fy ? 0 : fx < fy ? -1 : 1;
  })();
  return x.negative ? -magnitude : magnitude;
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
