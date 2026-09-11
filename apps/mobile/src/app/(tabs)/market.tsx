import type { MarketStatusDto } from '@tp/shared-types';
import { marketLabel } from '../../lib/market-state';
import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSession } from '../../lib/session';
import { useRealtimeQuotes } from '../../lib/use-realtime-quotes';
import { Empty, ErrorNote, Screen } from '../../components/ui';
import { NUMERIC_DIRECTION } from '../../lib/direction';
import { signColor, theme } from '../../lib/theme';

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
  const { api } = useSession();
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
      setError('Prices could not be loaded.');
    }
  }, [api]);

  useEffect(() => {
    void (async () => {
      try {
        setInstruments(await api.get<Instrument[]>('/symbols'));
      } catch {
        setError('Could not load instruments.');
      }
      await loadQuotes();
    })();
  }, [api, loadQuotes]);

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

  return (
    <Screen>
      {error === null ? null : <ErrorNote message={error} />}
      {status === 'live' ? null : (
        <Text style={styles.status}>
          {status === 'reconnecting' ? 'Reconnecting — prices may be stale' : 'Connecting…'}
        </Text>
      )}
      <FlatList
        data={(instruments ?? []).filter((instrument) => instrument.enabled)}
        keyExtractor={(item) => item.code}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void loadQuotes().finally(() => setRefreshing(false));
            }}
          />
        }
        ListEmptyComponent={
          <Empty message={instruments === null ? 'Loading…' : 'No instruments available.'} />
        }
        renderItem={({ item }) => {
          const quote = quotes[item.code];
          const before = previous[item.code];
          const change =
            quote === undefined || before === undefined ? 0 : Number(quote.bid) - Number(before);

          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Chart for ${item.code}`}
              onPress={() => router.push(`/chart/${item.code}`)}
              style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.code}>{item.code}</Text>
                <Text style={styles.name}>
                  {item.description}
                  {item.sessionOpen
                    ? ''
                    : ` · ${item.market === undefined ? 'market closed' : marketLabel(item.market)}`}
                </Text>
              </View>
              <View style={styles.prices}>
                <Text
                  style={[
                    styles.bid,
                    { color: signColor(change), writingDirection: NUMERIC_DIRECTION },
                  ]}
                >
                  {quote?.bid ?? '—'}
                </Text>
                <Text style={[styles.ask, { writingDirection: NUMERIC_DIRECTION }]}>
                  {quote?.ask ?? '—'}
                </Text>
              </View>
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    padding: theme.spacing(1.5),
    marginBottom: theme.spacing(1),
    minHeight: 56,
  },
  pressed: { opacity: 0.7 },
  code: { color: theme.colors.text, fontSize: 16, fontWeight: '600' },
  name: { color: theme.colors.textMuted, fontSize: 12 },
  prices: { alignItems: 'flex-end' },
  status: {
    color: theme.colors.warning,
    fontSize: 12,
    marginBottom: theme.spacing(1),
    textAlign: 'center',
  },
  bid: { fontSize: 16, fontFamily: theme.font.mono, fontWeight: '600' },
  ask: { color: theme.colors.textMuted, fontSize: 13, fontFamily: theme.font.mono },
});
