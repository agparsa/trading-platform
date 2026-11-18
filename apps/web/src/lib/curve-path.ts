/**
 * Screen geometry for the dashboard's equity chart.
 *
 * Drawing only: the server's decimal strings become pixel positions here and
 * nowhere else. No figure a trader reads is computed from these numbers —
 * the labels beside the chart are the server's own strings.
 */
export interface CurveGeometry {
  /** SVG path for each series, in the same x positions. */
  readonly lines: readonly string[];
  /** The closed area under the first series. */
  readonly area: string;
  /** The x position of each point, for hover targets. */
  readonly xs: readonly number[];
  readonly min: number;
  readonly max: number;
}

export function curveGeometry(
  series: ReadonlyArray<readonly string[]>,
  width: number,
  height: number,
  pad = 4,
): CurveGeometry | null {
  const first = series[0];
  if (first === undefined || first.length === 0) return null;
  const values = series.map((one) => one.map((v) => Number(v)));
  const all = values.flat().filter((v) => Number.isFinite(v));
  if (all.length === 0) return null;
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (min === max) {
    // A flat line sits in the middle rather than on an edge.
    const spread = Math.abs(min) * 0.01 || 1;
    min -= spread;
    max += spread;
  }
  const n = first.length;
  const x = (i: number) => (n === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (n - 1));
  const y = (v: number) => pad + ((max - v) * (height - 2 * pad)) / (max - min);
  const xs = first.map((_, i) => round(x(i)));
  const lines = values.map((one) =>
    one
      .map(
        (v, i) => `${i === 0 ? 'M' : 'L'}${round(x(i))},${round(y(Number.isFinite(v) ? v : min))}`,
      )
      .join(' '),
  );
  const firstLine = lines[0] ?? '';
  const area = `${firstLine} L${round(x(n - 1))},${height} L${round(x(0))},${height} Z`;
  return { lines, area, xs, min, max };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
