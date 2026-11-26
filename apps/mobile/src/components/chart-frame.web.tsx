import React, { useEffect, useRef } from 'react';
import type { ChartBar } from '@tp/chart-core';
import type { ChartLevel } from '../lib/chart-html';

/**
 * The browser preview's chart: the same page in an iframe. The phone uses
 * `chart-frame.tsx`; there is no WebView in a browser.
 */
export function ChartFrame({
  html,
  bars,
  levels = [],
  ready,
  onReady,
}: {
  html: string;
  bars: readonly ChartBar[] | null;
  /** The open positions' lines — the native frame's, drawn the same way. */
  levels?: readonly ChartLevel[];
  ready: boolean;
  onReady: () => void;
  onError: () => void;
}): React.ReactElement {
  const frame = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!ready || bars === null) return;
    const target = frame.current?.contentWindow as
      (Window & { __setBars?: (b: readonly ChartBar[]) => void }) | null | undefined;
    target?.__setBars?.(bars);
  }, [ready, bars]);

  const levelsKey = JSON.stringify(levels);
  useEffect(() => {
    if (!ready || bars === null) return;
    const target = frame.current?.contentWindow as
      (Window & { __setLevels?: (l: readonly ChartLevel[]) => void }) | null | undefined;
    target?.__setLevels?.(JSON.parse(levelsKey) as ChartLevel[]);
  }, [ready, bars, levelsKey]);

  return (
    <iframe
      ref={frame}
      srcDoc={html}
      title="chart"
      style={{ border: 0, width: '100%', height: '100%' }}
      onLoad={() => {
        const poll = (tries: number) => {
          const target = frame.current?.contentWindow as (Window & { __setBars?: unknown }) | null;
          if (typeof target?.__setBars === 'function') onReady();
          else if (tries > 0) setTimeout(() => poll(tries - 1), 200);
        };
        poll(25);
      }}
    />
  );
}
