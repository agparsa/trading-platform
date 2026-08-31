import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSession } from '../../lib/session';
import { Empty, ErrorNote, Screen } from '../../components/ui';
import { NUMERIC_DIRECTION } from '../../lib/direction';
import { formatSigned, signColor, theme } from '../../lib/theme';

interface Position {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: string;
  entryPrice: string;
  currentPrice: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  unrealisedPnl: string;
  openedAt: string;
}

export default function Positions(): React.ReactElement {
  const { api } = useSession();
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setPositions(await api.get<Position[]>('/positions'));
      setError(null);
    } catch {
      setError('Could not refresh positions.');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen>
      {error === null ? null : <ErrorNote message={error} />}
      <FlatList
        data={positions ?? []}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
        ListEmptyComponent={
          <Empty message={positions === null ? 'Loading…' : 'No open positions.'} />
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.rowTop}>
              <Text style={styles.symbol}>{item.symbol}</Text>
              <Text
                style={[
                  styles.side,
                  {
                    color: item.side === 'BUY' ? theme.colors.positive : theme.colors.negative,
                  },
                ]}
              >
                {item.side} {item.volume}
              </Text>
            </View>
            <View style={styles.rowBottom}>
              <Text style={styles.detail}>
                {item.entryPrice} → {item.currentPrice ?? '—'}
              </Text>
              <Text
                style={[
                  styles.pnl,
                  { color: signColor(item.unrealisedPnl), writingDirection: NUMERIC_DIRECTION },
                ]}
              >
                {formatSigned(item.unrealisedPnl)}
              </Text>
            </View>
            {item.stopLoss === null && item.takeProfit === null ? null : (
              <Text style={styles.protection}>
                {item.stopLoss === null ? 'no SL' : `SL ${item.stopLoss}`} ·{' '}
                {item.takeProfit === null ? 'no TP' : `TP ${item.takeProfit}`}
              </Text>
            )}
          </View>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    padding: theme.spacing(1.5),
    marginBottom: theme.spacing(1),
  },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: theme.spacing(0.5),
  },
  symbol: { color: theme.colors.text, fontSize: 16, fontWeight: '600' },
  side: { fontSize: 14, fontFamily: theme.font.mono },
  detail: { color: theme.colors.textMuted, fontSize: 13, fontFamily: theme.font.mono },
  pnl: { fontSize: 16, fontFamily: theme.font.mono, fontWeight: '600' },
  protection: { color: theme.colors.textMuted, fontSize: 12, marginTop: theme.spacing(0.5) },
});
