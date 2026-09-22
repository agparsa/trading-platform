import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { WebView } from 'react-native-webview';
import {
  RESOLUTIONS,
  RESOLUTION_LABEL,
  barWindow,
  createPlatformDatafeed,
  type ChartBar,
  type Resolution,
} from '@tp/chart-core';
import { useSession } from '../../lib/session';
import { Button, ErrorNote, Screen } from '../../components/ui';
import { chartHtml, setBarsScript } from '../../lib/chart-html';
import { theme } from '../../lib/theme';

interface Instrument {
  code: string;
  pricePrecision: number;
  tickSize: string;
}

/** How many bars to fetch. Enough to fill a phone screen and pan a little. */
const BARS = 200;

/**
 * The chart.
 *
 * Renders `lightweight-charts` in a WebView, fed through `@tp/chart-core` — the
 * same datafeed boundary the web terminal reads through, and the same renderer.
 * A second candlestick implementation for the phone would be two things to keep
 * looking alike, and a trader who saw a different chart on each device would be
 * right to distrust both.
 */
export default function Chart(): React.ReactElement {
  const { symbol } = useLocalSearchParams<{ symbol: string }>();
  const { api } = useSession();
  const router = useRouter();
  const webview = useRef<WebView>(null);

  const [resolution, setResolution] = useState<Resolution>('15');
  const [instrument, setInstrument] = useState<Instrument | null>(null);
  const [bars, setBars] = useState<readonly ChartBar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const datafeed = useMemo(() => createPlatformDatafeed(api), [api]);
  /**
   * The row of timeframes is what this deployment serves, asked once. Until it
   * answers, the platform's vocabulary — a chip that may then disappear is
   * preferred to a row that appears late. `30` is in the vocabulary and, on a
   * deployment that does not aggregate it, not in the answer.
   */
  const [served, setServed] = useState<readonly Resolution[]>(RESOLUTIONS);
  useEffect(() => {
    let cancelled = false;
    void datafeed
      .resolutions()
      .then((list) => {
        if (!cancelled && list.length > 0) setServed(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [datafeed]);

  useEffect(() => {
    void (async () => {
      try {
        setInstrument(await api.get<Instrument>(`/symbols/${String(symbol)}`));
      } catch {
        setError('Could not load the instrument.');
      }
    })();
  }, [api, symbol]);

  const load = useCallback(async () => {
    try {
      // The window is snapped to the bar boundary by `barWindow`, so it changes
      // once per bar instead of once per render — which is what stops this
      // becoming an accidental poll.
      const { fromMs, toMs } = barWindow(resolution, BARS, Date.now());
      setBars(await datafeed.history(String(symbol), resolution, fromMs, toMs));
      setError(null);
    } catch {
      setError('Could not load bars.');
    }
  }, [datafeed, symbol, resolution]);

  useEffect(() => {
    void load();
  }, [load]);

  // Fed only once the page says it is ready; an injection before then reaches a
  // document with no `__setBars` on it and is silently lost.
  useEffect(() => {
    if (!ready || bars === null) return;
    webview.current?.injectJavaScript(setBarsScript(bars));
  }, [ready, bars]);

  const html = useMemo(
    () =>
      chartHtml({
        theme: {
          background: theme.colors.background,
          text: theme.colors.textMuted,
          grid: theme.colors.border,
          up: theme.colors.positive,
          down: theme.colors.negative,
        },
        // The instrument's own precision, not a default: drawing EURUSD to two
        // decimals flattens every move it makes.
        pricePrecision: instrument?.pricePrecision ?? 2,
        minMove: instrument?.tickSize ?? '0.01',
      }),
    [instrument],
  );

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.symbol}>{String(symbol)}</Text>
        <View style={styles.resolutions}>
          {served.map((value) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: value === resolution }}
              accessibilityLabel={`${RESOLUTION_LABEL[value]} bars`}
              onPress={() => setResolution(value)}
              style={[styles.chip, value === resolution ? styles.chipActive : null]}
            >
              <Text
                style={[styles.chipLabel, value === resolution ? styles.chipLabelActive : null]}
              >
                {RESOLUTION_LABEL[value]}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {error === null ? null : <ErrorNote message={error} />}

      <View style={styles.chart}>
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
              if (message.type === 'ready') setReady(true);
              if (message.type === 'error') setError('The chart could not be drawn offline.');
            } catch {
              // A message we do not understand is not worth crashing over.
            }
          }}
          style={styles.webview}
        />
      </View>

      <Button
        label="Trade this instrument"
        onPress={() => router.push(`/trade/${String(symbol)}`)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { marginBottom: theme.spacing(1) },
  symbol: { color: theme.colors.text, fontSize: 22, fontWeight: '700' },
  resolutions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing(0.5),
    marginTop: theme.spacing(1),
  },
  chip: {
    paddingHorizontal: theme.spacing(1.5),
    paddingVertical: theme.spacing(0.75),
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surface,
    minHeight: 36,
    justifyContent: 'center',
  },
  chipActive: { backgroundColor: theme.colors.accent },
  chipLabel: { color: theme.colors.textMuted, fontSize: 13 },
  chipLabelActive: { color: '#FFFFFF', fontWeight: '600' },
  chart: { flex: 1, borderRadius: theme.radius.md, overflow: 'hidden' },
  webview: { backgroundColor: theme.colors.background },
});
