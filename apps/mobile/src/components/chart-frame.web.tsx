import React, { useEffect, useRef } from 'react';
import type { ChartBar } from '@tp/chart-core';
import type { ChartLevel } from '../lib/chart-html';
import type { DraggedLevel } from '../lib/chart-drag';

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
  onLevel,
  clearPreview = 0,
  liveBar = null,
}: {
  liveBar?: ChartBar | null;
  onLevel?: (level: DraggedLevel) => void;
  clearPreview?: number;
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

  useEffect(() => {
    if (!ready || bars === null || liveBar === null) return;
    const target = frame.current?.contentWindow as
      (Window & { __updateBar?: (b: ChartBar) => void }) | null | undefined;
    target?.__updateBar?.(liveBar);
  }, [ready, bars, liveBar]);

  // The page posts to its parent when it is not inside a native WebView.
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || typeof event.data !== 'string') return;
      try {
        const dropped = JSON.parse(event.data) as Partial<DraggedLevel> & { type?: string };
        if (
          dropped.type === 'level' &&
          typeof dropped.positionId === 'string' &&
          (dropped.kind === 'STOP_LOSS' || dropped.kind === 'TAKE_PROFIT') &&
          typeof dropped.price === 'string'
        ) {
          onLevel?.({ positionId: dropped.positionId, kind: dropped.kind, price: dropped.price });
        }
      } catch {
        // Not ours.
      }
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, [onLevel]);

  useEffect(() => {
    if (clearPreview === 0) return;
    const target = frame.current?.contentWindow as
      (Window & { __clearPreview?: () => void }) | null | undefined;
    target?.__clearPreview?.();
  }, [clearPreview]);

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
