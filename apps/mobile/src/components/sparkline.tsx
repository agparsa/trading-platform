import React, { useEffect, useMemo, useState } from 'react';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { createPlatformDatafeed, barWindow } from '@tp/chart-core';
import { useSession } from '../lib/session';
import { sparkPath } from '../lib/spark';

/**
 * A day of an instrument as a line, filled faintly beneath: green if the day
 * is up, red if down. Hourly closes from the platform's own bars, with the
 * live price as the last point. Decoration beside the prices, never instead.
 */
export function Sparkline({
  closes,
  width = 72,
  height = 30,
  up,
}: {
  closes: readonly number[];
  width?: number;
  height?: number;
  up: boolean;
}): React.ReactElement | null {
  const line = sparkPath(closes, width, height);
  if (line === '') return null;
  const color = up ? '#16C784' : '#EA3943';
  const id = up ? 'sparkUp' : 'sparkDown';
  const last = line.split(' ').at(-1)?.slice(1) ?? '';
  const first = line.split(' ')[0]?.slice(1) ?? '';
  const fill = `${line} L${last.split(',')[0]},${height} L${first.split(',')[0]},${height} Z`;
  return (
    <Svg width={width} height={height} accessibilityElementsHidden>
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity={0.28} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Path d={fill} fill={`url(#${id})`} />
      <Path d={line} stroke={color} strokeWidth={1.6} fill="none" strokeLinejoin="round" />
    </Svg>
  );
}

/**
 * The last day's hourly bars for each instrument, fetched once when the list
 * opens; the live price is drawn as the last point, so the line keeps moving
 * without a poll.
 */
export function useDayBars(
  codes: readonly string[],
): Readonly<Record<string, { first: string; closes: number[] }>> {
  const { api } = useSession();
  const datafeed = useMemo(() => createPlatformDatafeed(api), [api]);
  const [bars, setBars] = useState<Record<string, { first: string; closes: number[] }>>({});
  const key = codes.join(',');
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { fromMs, toMs } = barWindow('60', 24, Date.now());
      const entries = await Promise.all(
        key
          .split(',')
          .filter((code) => code !== '')
          .map(async (code) => {
            try {
              const rows = await datafeed.history(code, '60', fromMs, toMs);
              if (rows.length === 0) return null;
              return [
                code,
                { first: String(rows[0]?.open), closes: rows.map((row) => Number(row.close)) },
              ] as const;
            } catch {
              return null;
            }
          }),
      );
      if (cancelled) return;
      setBars(Object.fromEntries(entries.filter((entry) => entry !== null)));
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [datafeed, key]);
  return bars;
}
