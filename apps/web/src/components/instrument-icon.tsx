import { iconFor } from '@/lib/instrument-marks';

/**
 * An instrument's icon: one disc for a metal or a coin, two overlapping for a
 * currency pair. Drawn as SVG from `iconFor` — no image files, so nothing to
 * license, fetch or keep in step with the instrument list. Decorative: the
 * code beside it is what a screen reader reads.
 */
export function InstrumentIcon({ code, size = 20 }: { code: string; size?: number }) {
  const discs = iconFor(code);
  const pair = discs.length === 2;
  const r = pair ? size * 0.36 : size / 2;
  const width = pair ? size * 1.25 : size;
  const font = (glyph: string) => (glyph.length > 1 ? r * 0.85 : r * 1.15);
  const at = pair
    ? [
        { cx: r, cy: r + (size - 2 * r) * 0.15 },
        { cx: width - r, cy: size - r - (size - 2 * r) * 0.15 },
      ]
    : [{ cx: r, cy: r }];
  // The quote disc is drawn first so the base sits in front of it.
  const order = pair ? [1, 0] : [0];
  return (
    <svg
      aria-hidden
      width={width}
      height={size}
      viewBox={`0 0 ${width} ${size}`}
      className="shrink-0"
      data-testid="instrument-icon"
    >
      {order.map((index) => {
        const disc = discs[index]!;
        const { cx, cy } = at[index]!;
        return (
          <g key={index}>
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill={disc.fill}
              stroke="rgba(0,0,0,0.35)"
              strokeWidth={1}
            />
            <text
              x={cx}
              y={cy}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={font(disc.glyph)}
              fontWeight={700}
              fill="#fff"
              fontFamily="system-ui, sans-serif"
            >
              {disc.glyph}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
