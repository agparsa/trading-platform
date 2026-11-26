import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChartView } from '../../components/chart-view';
import { Chip, Empty, InstrumentBadge, PriceTile, Screen } from '../../components/ui';
import { NUMERIC_DIRECTION } from '../../lib/direction';
import { useRealtimeQuotes } from '../../lib/use-realtime-quotes';
import { useT } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { theme } from '../../lib/theme';

interface Instrument {
  code: string;
  enabled: boolean;
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
  const [symbol, setSymbol] = useState<string | null>(null);

  useEffect(() => {
    void api
      .get<Instrument[]>('/symbols')
      .then((rows) => setInstruments(rows.filter((row) => row.enabled).map((row) => row.code)))
      .catch(() => setInstruments([]));
  }, [api]);

  useEffect(() => {
    if (typeof params.symbol === 'string' && params.symbol !== '') setSymbol(params.symbol);
  }, [params.symbol]);

  const current = symbol ?? instruments?.[0] ?? null;

  const { quotes } = useRealtimeQuotes();
  const quote = current === null ? undefined : quotes[current];

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
            <Text style={[styles.last, { writingDirection: NUMERIC_DIRECTION }]}>
              {quote?.bid ?? '—'}
            </Text>
          </View>
          <ChartView symbol={current} />
          <View style={styles.actions}>
            <PriceTile
              side="SELL"
              label={t('common.SELL')}
              price={quote?.bid ?? null}
              accessibilityLabel={`${t('common.sell')} ${current}`}
              onPress={() => router.push(`/trade/${current}?side=SELL`)}
            />
            <PriceTile
              side="BUY"
              label={t('common.BUY')}
              price={quote?.ask ?? null}
              accessibilityLabel={`${t('common.buy')} ${current}`}
              onPress={() => router.push(`/trade/${current}?side=BUY`)}
            />
          </View>
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
  code: { color: theme.colors.text, fontSize: 18, fontWeight: '800' },
  sub: { color: theme.colors.textMuted, fontSize: 12, marginTop: 2 },
  last: { color: theme.colors.text, fontSize: 22, fontWeight: '800', fontFamily: theme.font.mono },
  actions: { flexDirection: 'row', gap: theme.spacing(1), marginTop: theme.spacing(1.25) },
});
