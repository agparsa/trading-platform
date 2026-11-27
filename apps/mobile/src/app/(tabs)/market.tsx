import type { MarketStatusDto } from '@tp/shared-types';
import { marketLabel } from '../../lib/market-state';
import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSession } from '../../lib/session';
import { useRealtimeQuotes } from '../../lib/use-realtime-quotes';
import { Chip, Empty, ErrorNote, InstrumentBadge, PriceTile, Screen } from '../../components/ui';
import { instrumentMark, type InstrumentFamily } from '../../lib/instrument-mark';
import { Sparkline, useDayBars } from '../../components/sparkline';
import { changePercent } from '../../lib/spark';
import { theme } from '../../lib/theme';
import { useT } from '../../lib/i18n';
import { useOneTap } from '../../lib/one-tap';

interface Quote {
  symbol: string;
  bid: string;
  ask: string;
  /** Served by the API so no client recomputes it. */
  spread: string;
  timestamp: number;
}

/** `/symbols` returns the contract spec plus whether its session is open. */
interface Instrument {
  code: string;
  description: string;
  quoteCurrency: string;
  enabled: boolean;
  sessionOpen: boolean;
  /** Why the market is shut, and when it is not (§36). Absent on an older API. */
  market?: MarketStatusDto;
}

export default function Market(): React.ReactElement {
  const t = useT();
  const { api } = useSession();
  const [search, setSearch] = useState('');
  const [family, setFamily] = useState<InstrumentFamily | 'all'>('all');
  const router = useRouter();
  const [instruments, setInstruments] = useState<Instrument[] | null>(null);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  /**
   * Prices arrive on the socket, not from a poll loop.
   *
   * A refetch every two seconds is a fixed cost per client per second whether
   * or not anything moved, and it is late by up to the interval on the one tick
   * that mattered. The REST call below runs once, to fill the list before the
   * first frame arrives.
   */
  const { quotes: live, status } = useRealtimeQuotes();
  const oneTap = useOneTap();
  const dayBars = useDayBars(
    (instruments ?? []).filter((row) => row.enabled).map((row) => row.code),
  );
  /** One-tap armed: the order goes now. Otherwise the ticket, to review it. */
  const press = (code: string, side: 'BUY' | 'SELL') => {
    if (oneTap.armed) void oneTap.send(code, side);
    else router.push(`/trade/${code}?side=${side}`);
  };

  const loadQuotes = useCallback(async () => {
    try {
      const next = await api.get<Quote[]>('/market/quotes');
      setQuotes(Object.fromEntries(next.map((quote) => [quote.symbol, quote])));
      setError(null);
    } catch {
      setError(t('quotes.loadFailed'));
    }
  }, [api, t]);

  useEffect(() => {
    void (async () => {
      try {
        setInstruments(await api.get<Instrument[]>('/symbols'));
      } catch {
        setError(t('quotes.instrumentsFailed'));
      }
      await loadQuotes();
    })();
  }, [api, loadQuotes, t]);

  useEffect(() => {
    setQuotes((current) => ({ ...current, ...live }));
    // `live` is the only trigger that matters; including `quotes` would loop.
  }, [live]);

  const needle = search.trim().toUpperCase();
  const rows = (instruments ?? []).filter(
    (instrument) =>
      instrument.enabled &&
      (family === 'all' || instrumentMark(instrument.code).family === family) &&
      (needle === '' ||
        instrument.code.includes(needle) ||
        instrument.description.toUpperCase().includes(needle)),
  );

  return (
    <Screen>
      {error === null ? null : <ErrorNote message={error} />}
      {status === 'live' ? null : (
        <Text style={styles.status}>
          {status === 'reconnecting' ? t('quotes.reconnecting') : t('quotes.connecting')}
        </Text>
      )}
      <TextInput
        value={search}
        onChangeText={setSearch}
        placeholder={t('quotes.search')}
        placeholderTextColor={theme.colors.textFaint}
        autoCapitalize="characters"
        autoCorrect={false}
        style={styles.search}
        accessibilityLabel={t('quotes.search')}
      />
      <View style={styles.families}>
        {FAMILIES.filter(
          (value) =>
            value === 'all' ||
            (instruments ?? []).some(
              (row) => row.enabled && instrumentMark(row.code).family === value,
            ),
        ).map((value) => (
          <Chip
            key={value}
            label={t(`quotes.family.${value}`)}
            active={family === value}
            onPress={() => setFamily(value)}
          />
        ))}
      </View>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.code}
        contentContainerStyle={{ paddingBottom: theme.spacing(2) }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={theme.colors.textMuted}
            onRefresh={() => {
              setRefreshing(true);
              void loadQuotes().finally(() => setRefreshing(false));
            }}
          />
        }
        ListEmptyComponent={
          <Empty message={instruments === null ? t('common.loading') : t('quotes.none')} />
        }
        renderItem={({ item }) => {
          const quote = quotes[item.code];
          const day = dayBars[item.code];
          const pct = changePercent(day?.first ?? null, quote?.bid ?? null);
          const up = pct === null || !pct.startsWith('-');
          const closes =
            day === undefined
              ? []
              : quote === undefined
                ? day.closes
                : [...day.closes, Number(quote.bid)];

          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${t('quotes.chart')} ${item.code}`}
              onPress={() => router.push(`/(tabs)/chart?symbol=${item.code}`)}
              style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
            >
              <View style={styles.rowTop}>
                <InstrumentBadge code={item.code} size={34} />
                <View style={styles.instrument}>
                  <Text style={styles.code}>{item.code}</Text>
                  <Text
                    style={[styles.name, item.sessionOpen ? null : { color: theme.colors.warning }]}
                    numberOfLines={1}
                  >
                    {item.sessionOpen
                      ? item.description
                      : item.market === undefined
                        ? t('market.closed')
                        : marketLabel(item.market, t)}
                  </Text>
                </View>
                <Sparkline closes={closes} up={up} width={60} height={26} />
                <View
                  style={[
                    styles.change,
                    { backgroundColor: up ? theme.colors.buyTint : theme.colors.sellTint },
                  ]}
                >
                  <Text
                    style={[
                      styles.changeText,
                      { color: up ? theme.colors.positive : theme.colors.negative },
                    ]}
                  >
                    {pct ?? '—'}
                  </Text>
                </View>
              </View>
              <View style={styles.tiles}>
                <PriceTile
                  compact
                  side="SELL"
                  label={t('common.SELL')}
                  price={quote?.bid ?? null}
                  accessibilityLabel={`${t('common.sell')} ${item.code} ${quote?.bid ?? ''}`}
                  armed={oneTap.armed}
                  busy={oneTap.busy === `${item.code}:SELL`}
                  onPress={() => press(item.code, 'SELL')}
                />
                <View style={styles.spread}>
                  <Text style={styles.spreadLabel}>{t('ticket.spread')}</Text>
                  <Text style={styles.spreadValue}>{quote?.spread ?? '—'}</Text>
                </View>
                <PriceTile
                  compact
                  side="BUY"
                  label={t('common.BUY')}
                  price={quote?.ask ?? null}
                  accessibilityLabel={`${t('common.buy')} ${item.code} ${quote?.ask ?? ''}`}
                  armed={oneTap.armed}
                  busy={oneTap.busy === `${item.code}:BUY`}
                  onPress={() => press(item.code, 'BUY')}
                />
              </View>
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}

const FAMILIES: ReadonlyArray<InstrumentFamily | 'all'> = ['all', 'fx', 'metal', 'crypto', 'other'];

const styles = StyleSheet.create({
  search: {
    fontFamily: theme.font.regular,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    color: theme.colors.text,
    minHeight: theme.control.md,
    paddingHorizontal: theme.spacing(1.75),
    marginBottom: theme.spacing(1.25),
    fontSize: theme.type.body,
  },
  families: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing(0.75),
    marginBottom: theme.spacing(1.5),
  },
  row: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    padding: theme.spacing(1.25),
    marginBottom: theme.spacing(1),
    gap: theme.spacing(1),
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1.5) },
  pressed: { opacity: 0.8 },
  instrument: { flex: 1, alignItems: 'flex-start', minWidth: 0 },
  code: { fontFamily: theme.font.heavy, color: theme.colors.text, fontSize: theme.type.title },
  name: {
    fontFamily: theme.font.regular,
    color: theme.colors.textMuted,
    fontSize: theme.type.label,
    marginTop: 2,
  },
  change: {
    borderRadius: theme.radius.xs,
    paddingHorizontal: theme.spacing(1),
    paddingVertical: theme.spacing(0.5),
    minWidth: 68,
    alignItems: 'center',
  },
  changeText: { fontFamily: theme.font.monoBold, fontSize: theme.type.label },
  tiles: { flexDirection: 'row', alignItems: 'stretch', gap: theme.spacing(1) },
  spread: { justifyContent: 'center', alignItems: 'center', minWidth: 52 },
  spreadLabel: {
    fontFamily: theme.font.medium,
    color: theme.colors.textFaint,
    fontSize: theme.type.caption,
  },
  spreadValue: {
    fontFamily: theme.font.mono,
    color: theme.colors.textMuted,
    fontSize: theme.type.label,
  },
  status: {
    fontFamily: theme.font.regular,
    color: theme.colors.warning,
    fontSize: theme.type.label,
    marginBottom: theme.spacing(1),
    textAlign: 'center',
  },
});
