import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSession } from '../../lib/session';
import { Empty, ErrorNote, Screen } from '../../components/ui';
import { NUMERIC_DIRECTION } from '../../lib/direction';
import { formatSigned, signColor, theme } from '../../lib/theme';

interface Trade {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: string;
  entryPrice: string;
  exitPrice: string;
  grossPnl: string;
  commission: string;
  swap: string;
  netPnl: string;
  closeReason: string;
  entryTime: string;
  exitTime: string;
}

interface Account {
  id: string;
}

const REASON_LABEL: Record<string, string> = {
  MANUAL: 'closed',
  STOP_LOSS: 'stopped out',
  TRAILING_STOP: 'trailing stop',
  TAKE_PROFIT: 'take profit',
  LIQUIDATION: 'liquidated',
  REVERSE: 'reversed',
  SYSTEM: 'closed by the system',
};

/**
 * Closed trades, with the costs shown separately.
 *
 * Net P&L is the number that matters, but showing only the net hides where it
 * went. A trader whose gross was positive and whose net was not should be able
 * to see that it was commission, and how much — that is the difference between
 * a strategy that does not work and a size that does not.
 */
export default function History(): React.ReactElement {
  const { api } = useSession();
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const accounts = await api.get<Account[]>('/accounts');
      const account = accounts[0];
      if (account === undefined) {
        setTrades([]);
        return;
      }
      setTrades(
        await api.get<Trade[]>('/trades', { query: { accountId: account.id, limit: 100 } }),
      );
      setError(null);
    } catch {
      setError('Could not load trade history.');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen>
      {error === null ? null : <ErrorNote message={error} />}
      <FlatList
        data={trades ?? []}
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
        ListEmptyComponent={<Empty message={trades === null ? 'Loading…' : 'No closed trades.'} />}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.top}>
              <Text style={styles.symbol}>
                {item.symbol} {item.side} {item.volume}
              </Text>
              <Text
                style={[
                  styles.net,
                  { color: signColor(item.netPnl), writingDirection: NUMERIC_DIRECTION },
                ]}
              >
                {formatSigned(item.netPnl)}
              </Text>
            </View>
            <Text style={[styles.detail, { writingDirection: NUMERIC_DIRECTION }]}>
              {item.entryPrice} → {item.exitPrice} ·{' '}
              {REASON_LABEL[item.closeReason] ?? item.closeReason}
            </Text>
            {/* Where the net came from. Hiding the costs hides the difference
                between a strategy that does not work and a size that does not. */}
            <Text style={[styles.costs, { writingDirection: NUMERIC_DIRECTION }]}>
              gross {formatSigned(item.grossPnl)} · commission {item.commission} · swap {item.swap}
            </Text>
            <Text style={styles.when}>{new Date(item.exitTime).toLocaleString()}</Text>
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
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  symbol: { color: theme.colors.text, fontSize: 15, fontWeight: '600' },
  net: { fontSize: 16, fontFamily: theme.font.mono, fontWeight: '600' },
  detail: {
    color: theme.colors.textMuted,
    fontSize: 13,
    fontFamily: theme.font.mono,
    marginTop: theme.spacing(0.25),
  },
  costs: {
    color: theme.colors.textMuted,
    fontSize: 11,
    fontFamily: theme.font.mono,
    marginTop: theme.spacing(0.25),
  },
  when: { color: theme.colors.textMuted, fontSize: 11, marginTop: theme.spacing(0.5) },
});
