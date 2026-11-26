import React, { useEffect, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import type { ChartBar } from '@tp/chart-core';
import { setBarsScript, setLevelsScript, type ChartLevel } from '../lib/chart-html';
import { theme } from '../lib/theme';

/**
 * The chart page, in a WebView, fed its bars once it says it is ready.
 * `chart-frame.web.tsx` is the browser preview's stand-in.
 */
export function ChartFrame({
  html,
  bars,
  levels = [],
  ready,
  onReady,
  onError,
}: {
  html: string;
  bars: readonly ChartBar[] | null;
  /** The open positions' entry, stop and target lines. */
  levels?: readonly ChartLevel[];
  ready: boolean;
  onReady: () => void;
  onError: () => void;
}): React.ReactElement {
  const webview = useRef<WebView>(null);

  // Fed only once the page says it is ready; an injection before then reaches a
  // document with no `__setBars` on it and is silently lost.
  useEffect(() => {
    if (!ready || bars === null) return;
    webview.current?.injectJavaScript(setBarsScript(bars));
  }, [ready, bars]);

  // After the bars, so the lines land on a series that exists. Keyed by the
  // lines' content, so a P&L tick that changes nothing drawn sends nothing.
  const levelsKey = JSON.stringify(levels);
  useEffect(() => {
    if (!ready || bars === null) return;
    webview.current?.injectJavaScript(setLevelsScript(JSON.parse(levelsKey) as ChartLevel[]));
  }, [ready, bars, levelsKey]);

  return (
    <WebView
      ref={webview}
      originWhitelist={['*']}
      source={{ html }}
      /**
       * No navigation out of the chart.
       *
       * The page is ours and has nothing to navigate to. A WebView that will
       * follow a link is a WebView that can be taken somewhere else, and this
       * one sits inside an app holding a trading session.
       */
      onShouldStartLoadWithRequest={(request) => request.url === 'about:blank'}
      javaScriptEnabled
      scrollEnabled={false}
      onMessage={(event) => {
        try {
          const message = JSON.parse(event.nativeEvent.data) as { type?: string };
          if (message.type === 'ready') onReady();
          if (message.type === 'error') onError();
        } catch {
          // A message we do not understand is not worth crashing over.
        }
      }}
      style={styles.webview}
    />
  );
}

const styles = StyleSheet.create({
  webview: { backgroundColor: theme.colors.background },
});
