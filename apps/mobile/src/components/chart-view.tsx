import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  RESOLUTIONS,
  RESOLUTION_LABEL,
  barWindow,
  createPlatformDatafeed,
  type ChartBar,
  type Resolution,
} from '@tp/chart-core';
import { useSession } from '../lib/session';
import { useT } from '../lib/i18n';
import { chartHtml } from '../lib/chart-html';
import { theme } from '../lib/theme';
import { ChartFrame } from './chart-frame';
import { ErrorNote } from './ui';

interface Instrument {
  code: string;
  pricePrecision: number;
  tickSize: string;
}

/** How many bars to fetch. Enough to fill a phone screen and pan a little. */
const BARS = 200;

/**
 * One instrument's candles, with the timeframes this deployment serves.
 *
 * Renders `lightweight-charts` in a WebView, fed through `@tp/chart-core` — the
 * same datafeed boundary the web terminal reads through, and the same renderer.
 * A second candlestick implementation for the phone would be two things to keep
 * looking alike, and a trader who saw a different chart on each device would be
 * right to distrust both.
 */
export function ChartView({ symbol }: { symbol: string }): React.ReactElement {
  const t = useT();
  const { api } = useSession();
  const [resolution, setResolution] = useState<Resolution>('15');
  const [instrument, setInstrument] = useState<Instrument | null>(null);
  const [bars, setBars] = useState<readonly ChartBar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const datafeed = useMemo(() => createPlatformDatafeed(api), [api]);
  /**
   * The row of timeframes is what this deployment serves, asked once. Until it
   * answers, the platform's vocabulary — a chip that may then disappear is
   * preferred to a row that appears late.
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
    setInstrument(null);
    setReady(false);
    void (async () => {
      try {
        setInstrument(await api.get<Instrument>(`/symbols/${symbol}`));
      } catch {
        setError(t('chart.instrumentFailed'));
      }
    })();
  }, [api, symbol, t]);

  const load = useCallback(async () => {
    try {
      // Snapped to the bar boundary by `barWindow`, so it changes once per bar
      // instead of once per render — which stops this becoming a poll.
      const { fromMs, toMs } = barWindow(resolution, BARS, Date.now());
      setBars(await datafeed.history(symbol, resolution, fromMs, toMs));
      setError(null);
    } catch {
      setError(t('chart.barsFailed'));
    }
  }, [datafeed, symbol, resolution, t]);

  useEffect(() => {
    void load();
  }, [load]);

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
        // The instrument's own precision: drawing EURUSD to two decimals
        // flattens every move it makes.
        pricePrecision: instrument?.pricePrecision ?? 2,
        minMove: instrument?.tickSize ?? '0.01',
      }),
    [instrument],
  );

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.resolutions}
        style={{ flexGrow: 0 }}
      >
        {served.map((value) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityState={{ selected: value === resolution }}
            accessibilityLabel={`${RESOLUTION_LABEL[value]}`}
            onPress={() => setResolution(value)}
            style={[styles.chip, value === resolution ? styles.chipActive : null]}
          >
            <Text style={[styles.chipLabel, value === resolution ? styles.chipLabelActive : null]}>
              {RESOLUTION_LABEL[value]}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {error === null ? null : <ErrorNote message={error} />}
      <View style={styles.chart}>
        <ChartFrame
          key={symbol}
          html={html}
          bars={bars}
          ready={ready}
          onReady={() => setReady(true)}
          onError={() => setError(t('chart.offline'))}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  resolutions: { gap: theme.spacing(0.5), paddingBottom: theme.spacing(1) },
  chip: {
    paddingHorizontal: theme.spacing(1.5),
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surface,
    minHeight: 32,
    justifyContent: 'center',
  },
  chipActive: { backgroundColor: theme.colors.accent },
  chipLabel: { color: theme.colors.textMuted, fontSize: 13 },
  chipLabelActive: { color: '#FFFFFF', fontWeight: '600' },
  chart: { flex: 1, borderRadius: theme.radius.md, overflow: 'hidden' },
});
