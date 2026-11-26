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
import { levelsFor, type LevelSource } from '../lib/chart-levels';
import { useAccounts } from '../lib/accounts';
import { useLiveBook } from '../lib/live';
import { applyPnl, type MarkedRow } from '../lib/live-book';

type BookRow = LevelSource & MarkedRow;
import { theme } from '../lib/theme';
import { ChartFrame } from './chart-frame';
import { Button, ErrorNote } from './ui';
import { dragPatch, type DraggedLevel } from '../lib/chart-drag';
import { refusalText } from '../lib/messages';

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
   * The selected account's open positions, for their lines on this chart —
   * the same list the Positions tab reads, refetched when a frame says it
   * changed, with each row's P&L following the server's newest mark.
   */
  const { selected: account } = useAccounts();
  const live = useLiveBook();
  const [book, setBook] = useState<readonly BookRow[] | null>(null);
  /** Bumped after a level is saved, so the lines are the server's at once. */
  const [refetch, setRefetch] = useState(0);
  /** A line the trader dropped, waiting for their yes. */
  const [dropped, setDropped] = useState<DraggedLevel | null>(null);
  const [clearPreview, setClearPreview] = useState(0);
  const [saving, setSaving] = useState(false);
  const [levelError, setLevelError] = useState<string | null>(null);

  const answer = async (send: boolean) => {
    const level = dropped;
    if (level === null) return;
    if (!send) {
      setDropped(null);
      setClearPreview((n) => n + 1);
      return;
    }
    setSaving(true);
    setLevelError(null);
    try {
      const patch = dragPatch(level);
      await api.patch(`/positions/${level.positionId}`, patch, {
        idempotencyKey: `levels:${level.positionId}:${JSON.stringify(patch)}`,
      });
      setRefetch((n) => n + 1);
    } catch (caught) {
      // The confirmed line is where it always was; the reason is the server's.
      setLevelError(refusalText(caught, 'positions.levelsFailed', t));
    } finally {
      setSaving(false);
      setDropped(null);
      setClearPreview((n) => n + 1);
    }
  };
  useEffect(() => {
    if (account === null) {
      setBook([]);
      return;
    }
    let cancelled = false;
    void api
      .get<BookRow[]>('/positions', { query: { accountId: account.id } })
      .then((rows) => {
        if (!cancelled) setBook(rows);
      })
      // No lines is the honest picture of a book that could not be read; the
      // Positions tab says why.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, account, live.versions.positions, refetch]);
  const marked = applyPnl(book, account === null ? undefined : live.pnl[account.id]);
  const levels = useMemo(() => levelsFor(marked ?? [], symbol), [marked, symbol]);
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
          profit: theme.colors.profit,
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
          levels={levels}
          ready={ready}
          onReady={() => setReady(true)}
          onError={() => setError(t('chart.offline'))}
          onLevel={(level) => {
            setLevelError(null);
            setDropped(level);
          }}
          clearPreview={clearPreview}
        />
      </View>
      {levelError === null ? null : <ErrorNote message={levelError} />}
      {dropped === null ? (
        levels.some((level) => level.drag !== undefined) ? (
          <Text style={styles.dragHint}>{t('chart.dragHint')}</Text>
        ) : null
      ) : (
        <View
          style={[
            styles.ask,
            {
              borderColor:
                dropped.kind === 'STOP_LOSS' ? theme.colors.negative : theme.colors.profit,
            },
          ]}
        >
          <Text style={styles.askText}>
            {t(dropped.kind === 'STOP_LOSS' ? 'chart.setStop' : 'chart.setTarget', {
              price: dropped.price,
            })}
          </Text>
          <View style={styles.askButtons}>
            <View style={{ flex: 1 }}>
              <Button
                label={t('chart.set')}
                variant={dropped.kind === 'STOP_LOSS' ? 'danger' : 'primary'}
                busy={saving}
                onPress={() => void answer(true)}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                label={t('common.cancel')}
                variant="quiet"
                onPress={() => void answer(false)}
              />
            </View>
          </View>
        </View>
      )}
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
  chipLabel: { fontFamily: theme.font.regular, color: theme.colors.textMuted, fontSize: 13 },
  chipLabelActive: { fontFamily: theme.font.semibold, color: '#FFFFFF' },
  dragHint: {
    fontFamily: theme.font.regular,
    color: theme.colors.textFaint,
    fontSize: 11,
    textAlign: 'center',
    marginTop: 6,
  },
  ask: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    padding: theme.spacing(1.25),
    marginTop: theme.spacing(1),
  },
  askText: { fontFamily: theme.font.semibold, color: theme.colors.text, fontSize: 14 },
  askButtons: { flexDirection: 'row', gap: theme.spacing(1) },
  chart: { flex: 1, borderRadius: theme.radius.md, overflow: 'hidden' },
});
