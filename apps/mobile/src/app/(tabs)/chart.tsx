import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChartView } from '../../components/chart-view';
import { Chip, Empty, InstrumentBadge, PriceTile, Screen } from '../../components/ui';
import { NUMERIC_DIRECTION } from '../../lib/direction';
import { useRealtimeQuotes } from '../../lib/use-realtime-quotes';
import { useOneTap } from '../../lib/one-tap';
import { OneTapSwitch } from '../../components/one-tap';
import { stepLots } from '../../lib/level-points';
import { useDayBars } from '../../components/sparkline';
import { changePercent } from '../../lib/spark';
import { useT } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { theme } from '../../lib/theme';

interface Instrument {
  code: string;
  enabled: boolean;
  volumeStep: string;
  minVolume: string;
}

/**
 * The chart tab: one instrument at a time, chosen from the row above it, with
 * Sell and Buy beneath. A symbol in the address (`?symbol=`) — Quotes sends
 * one — picks the instrument.
 */
export default function ChartTab(): React.ReactElement {
  const t = useT();
  const { api } = useSession();
  const router = useRouter();
  const params = useLocalSearchParams<{ symbol?: string }>();
  const [instruments, setInstruments] = useState<string[] | null>(null);
  const [grids, setGrids] = useState<Record<string, { step: string; min: string }>>({});
  const [symbol, setSymbol] = useState<string | null>(null);

  useEffect(() => {
    void api
      .get<Instrument[]>('/symbols')
      .then((rows) => {
        const enabled = rows.filter((row) => row.enabled);
        setInstruments(enabled.map((row) => row.code));
        setGrids(
          Object.fromEntries(
            enabled.map((row) => [row.code, { step: row.volumeStep, min: row.minVolume }]),
          ),
        );
      })
      .catch(() => setInstruments([]));
  }, [api]);

  useEffect(() => {
    if (typeof params.symbol === 'string' && params.symbol !== '') setSymbol(params.symbol);
  }, [params.symbol]);

  const current = symbol ?? instruments?.[0] ?? null;

  const { quotes } = useRealtimeQuotes();
  const oneTap = useOneTap();
  const press = (code: string, side: 'BUY' | 'SELL') => {
    if (oneTap.armed) void oneTap.send(code, side);
    else router.push(`/trade/${code}?side=${side}`);
  };
  const quote = current === null ? undefined : quotes[current];
  const day = useDayBars(current === null ? [] : [current]);
  const dayChange =
    current === null ? null : changePercent(day[current]?.first ?? null, quote?.bid ?? null);

  return (
    <Screen>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={styles.symbols}
      >
        {(instruments ?? []).map((code) => (
          <Chip key={code} label={code} active={code === current} onPress={() => setSymbol(code)} />
        ))}
      </ScrollView>
      {current === null ? (
        <Empty message={instruments === null ? t('common.loading') : t('quotes.none')} />
      ) : (
        <>
          <View style={styles.head}>
            <InstrumentBadge code={current} size={34} />
            <View style={{ flex: 1 }}>
              <Text style={styles.code}>{current}</Text>
              <Text style={styles.sub}>
                {quote === undefined ? '—' : t('quotes.spread', { spread: quote.spread })}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={[styles.last, { writingDirection: NUMERIC_DIRECTION }]}>
                {quote?.bid ?? '—'}
              </Text>
              {dayChange === null ? null : (
                <Text
                  style={[
                    styles.dayChange,
                    {
                      color: dayChange.startsWith('-')
                        ? theme.colors.negative
                        : theme.colors.positive,
                    },
                  ]}
                >
                  {dayChange}
                </Text>
              )}
            </View>
          </View>
          <ChartView symbol={current} />
          <View style={styles.lotsRow}>
            {/* The lots a one-tap order sends, on this instrument's grid. */}
            <View style={styles.lots}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('ticket.decrease')}
                onPress={() => oneTap.setLots(stepLots(oneTap.lots, grids[current] ?? null, -1))}
                style={styles.lotsButton}
              >
                <Text style={styles.lotsGlyph}>−</Text>
              </Pressable>
              <View style={{ alignItems: 'center' }}>
                <TextInput
                  value={oneTap.lots}
                  onChangeText={oneTap.setLots}
                  keyboardType="decimal-pad"
                  accessibilityLabel={t('oneTap.lots')}
                  style={styles.lotsInput}
                />
                <Text style={styles.lotsLabel}>{t('oneTap.lots')}</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('ticket.increase')}
                onPress={() => oneTap.setLots(stepLots(oneTap.lots, grids[current] ?? null, 1))}
                style={styles.lotsButton}
              >
                <Text style={styles.lotsGlyph}>+</Text>
              </Pressable>
            </View>
          </View>
          <View style={styles.actions}>
            <PriceTile
              side="SELL"
              label={t('common.SELL')}
              price={quote?.bid ?? null}
              armed={oneTap.armed}
              busy={oneTap.busy === `${current}:SELL`}
              accessibilityLabel={`${t('common.sell')} ${current}`}
              onPress={() => press(current, 'SELL')}
            />
            <PriceTile
              side="BUY"
              label={t('common.BUY')}
              price={quote?.ask ?? null}
              armed={oneTap.armed}
              busy={oneTap.busy === `${current}:BUY`}
              accessibilityLabel={`${t('common.buy')} ${current}`}
              onPress={() => press(current, 'BUY')}
            />
          </View>
          <OneTapSwitch />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  symbols: { gap: theme.spacing(0.75), paddingBottom: theme.spacing(1.25) },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing(1.25),
    marginBottom: theme.spacing(1),
  },
  code: { fontFamily: theme.font.heavy, color: theme.colors.text, fontSize: theme.type.title },
  sub: {
    fontFamily: theme.font.regular,
    color: theme.colors.textMuted,
    fontSize: theme.type.label,
    marginTop: 4,
  },
  dayChange: { fontFamily: theme.font.monoBold, fontSize: theme.type.label, marginTop: 2 },
  last: {
    fontFamily: theme.font.monoHeavy,
    color: theme.colors.text,
    fontSize: theme.type.heading,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: theme.spacing(0.75),
    marginTop: theme.spacing(0.75),
    marginBottom: theme.spacing(1),
  },
  lotsRow: { alignItems: 'center', marginTop: theme.spacing(1) },
  lots: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  lotsButton: {
    width: 44,
    minHeight: theme.control.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lotsGlyph: {
    fontFamily: theme.font.medium,
    color: theme.colors.text,
    fontSize: theme.type.heading,
  },
  lotsInput: {
    fontFamily: theme.font.monoBold,
    color: theme.colors.text,
    fontSize: theme.type.body,
    textAlign: 'center',
    minWidth: 48,
    padding: 0,
  },
  lotsLabel: {
    fontFamily: theme.font.medium,
    color: theme.colors.textMuted,
    fontSize: theme.type.caption,
  },
});
