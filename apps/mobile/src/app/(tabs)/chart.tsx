import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChartView } from '../../components/chart-view';
import { Empty, Screen } from '../../components/ui';
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

  return (
    <Screen>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={styles.symbols}
      >
        {(instruments ?? []).map((code) => (
          <Pressable
            key={code}
            accessibilityRole="button"
            accessibilityState={{ selected: code === current }}
            onPress={() => setSymbol(code)}
            style={[styles.symbol, code === current ? styles.symbolActive : null]}
          >
            <Text style={[styles.symbolLabel, code === current ? styles.symbolLabelActive : null]}>
              {code}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {current === null ? (
        <Empty message={instruments === null ? t('common.loading') : t('quotes.none')} />
      ) : (
        <>
          <ChartView symbol={current} />
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              style={[styles.action, { backgroundColor: theme.colors.negative }]}
              onPress={() => router.push(`/trade/${current}?side=SELL`)}
            >
              <Text style={styles.actionLabel}>{t('common.sell')}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={[styles.action, { backgroundColor: theme.colors.positive }]}
              onPress={() => router.push(`/trade/${current}?side=BUY`)}
            >
              <Text style={styles.actionLabel}>{t('common.buy')}</Text>
            </Pressable>
          </View>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  symbols: { gap: theme.spacing(0.75), paddingBottom: theme.spacing(1) },
  symbol: {
    paddingHorizontal: theme.spacing(1.5),
    minHeight: 34,
    justifyContent: 'center',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  symbolActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface },
  symbolLabel: { color: theme.colors.textMuted, fontSize: 13, fontWeight: '600' },
  symbolLabelActive: { color: theme.colors.text },
  actions: { flexDirection: 'row', gap: theme.spacing(1), marginTop: theme.spacing(1) },
  action: {
    flex: 1,
    minHeight: 48,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
});
