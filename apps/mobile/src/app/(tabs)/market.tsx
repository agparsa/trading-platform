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
import { changeColor, theme } from '../../lib/theme';
import { useT } from '../../lib/i18n';

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
  const [previous, setPrevious] = useState<Record<string, string>>({});
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
    setPrevious((current) => {
      const carried = { ...current };
      for (const [symbol, quote] of Object.entries(live)) {
        const known = quotes[symbol]?.bid;
        if (known !== undefined && known !== quote.bid) carried[symbol] = known;
      }
      return carried;
    });
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
          const before = previous[item.code];
          const change =
            quote === undefined || before === undefined ? 0 : Number(quote.bid) - Number(before);
          const tick = change === 0 ? undefined : changeColor(change);

          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${t('quotes.chart')} ${item.code}`}
              onPress={() => router.push(`/(tabs)/chart?symbol=${item.code}`)}
              style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
            >
              <InstrumentBadge code={item.code} />
              <View style={styles.instrument}>
                <Text style={styles.code}>{item.code}</Text>
                <Text
                  style={[styles.name, item.sessionOpen ? null : { color: theme.colors.warning }]}
                  numberOfLines={1}
                >
                  {item.sessionOpen
                    ? quote === undefined
                      ? item.description
                      : t('quotes.spread', { spread: quote.spread })
                    : item.market === undefined
                      ? t('market.closed')
                      : marketLabel(item.market, t)}
                </Text>
              </View>
              <View style={styles.tiles}>
                <PriceTile
                  compact
                  side="SELL"
                  label={t('common.SELL')}
                  price={quote?.bid ?? null}
                  {...(tick === undefined ? {} : { tone: tick })}
                  accessibilityLabel={`${t('common.sell')} ${item.code} ${quote?.bid ?? ''}`}
                  onPress={() => router.push(`/trade/${item.code}?side=SELL`)}
                />
                <PriceTile
                  compact
                  side="BUY"
                  label={t('common.BUY')}
                  price={quote?.ask ?? null}
                  {...(tick === undefined ? {} : { tone: tick })}
                  accessibilityLabel={`${t('common.buy')} ${item.code} ${quote?.ask ?? ''}`}
                  onPress={() => router.push(`/trade/${item.code}?side=BUY`)}
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
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    color: theme.colors.text,
    minHeight: 44,
    paddingHorizontal: theme.spacing(1.75),
    marginBottom: theme.spacing(1.25),
    fontSize: 15,
  },
  families: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing(0.75),
    marginBottom: theme.spacing(1.5),
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing(1.25),
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing(1.25),
    paddingHorizontal: theme.spacing(1.5),
    marginBottom: theme.spacing(1),
  },
  pressed: { opacity: 0.75 },
  instrument: { flex: 1, alignItems: 'flex-start', minWidth: 0 },
  code: { color: theme.colors.text, fontSize: 16, fontWeight: '800', letterSpacing: 0.3 },
  name: { color: theme.colors.textMuted, fontSize: 12, marginTop: 3 },
  tiles: { flexDirection: 'row', gap: 6, width: 196 },
  status: {
    color: theme.colors.warning,
    fontSize: 12,
    marginBottom: theme.spacing(1),
    textAlign: 'center',
  },
});
