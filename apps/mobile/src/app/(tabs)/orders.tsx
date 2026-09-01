import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { DomainError } from '@tp/shared-types';
import { useSession } from '../../lib/session';
import { Button, Empty, ErrorNote, Screen } from '../../components/ui';
import { NUMERIC_DIRECTION } from '../../lib/direction';
import { theme } from '../../lib/theme';

interface PendingOrder {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'STOP';
  volume: string;
  price: string;
  stopLoss: string | null;
  takeProfit: string | null;
  timeInForce: string;
  expiresAt: string | null;
  status: string;
}

interface Account {
  id: string;
}

/**
 * Resting orders.
 *
 * A pending order is a promise the platform keeps while nobody is watching, and
 * the only thing a trader can do about one from a phone is see it and cancel
 * it. Cancelling is behind a confirmation because it is irreversible in the way
 * that matters: the price it was waiting for may not come back.
 */
export default function Orders(): React.ReactElement {
  const { api } = useSession();
  const [orders, setOrders] = useState<PendingOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const accounts = await api.get<Account[]>('/accounts');
      const account = accounts[0];
      if (account === undefined) {
        setOrders([]);
        return;
      }
      setOrders(
        await api.get<PendingOrder[]>('/orders/pending', { query: { accountId: account.id } }),
      );
      setError(null);
    } catch {
      setError('Could not load resting orders.');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const cancel = async (order: PendingOrder) => {
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/orders/${order.orderId}`, {
        idempotencyKey: `cancel:${order.orderId}`,
      });
      setCancelling(null);
      await load();
    } catch (caught) {
      setError(caught instanceof DomainError ? caught.message : 'The order was not cancelled.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      {error === null ? null : <ErrorNote message={error} />}
      <FlatList
        data={orders ?? []}
        keyExtractor={(item) => item.orderId}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
        ListEmptyComponent={<Empty message={orders === null ? 'Loading…' : 'No resting orders.'} />}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.top}>
              <Text style={styles.symbol}>{item.symbol}</Text>
              <Text
                style={[
                  styles.side,
                  {
                    color: item.side === 'BUY' ? theme.colors.positive : theme.colors.negative,
                  },
                ]}
              >
                {item.type} {item.side} {item.volume}
              </Text>
            </View>
            <Text style={[styles.detail, { writingDirection: NUMERIC_DIRECTION }]}>
              at {item.price} · {item.timeInForce}
              {item.expiresAt === null
                ? ''
                : ` · expires ${new Date(item.expiresAt).toLocaleString()}`}
            </Text>
            {item.stopLoss === null && item.takeProfit === null ? null : (
              <Text style={styles.detail}>
                {item.stopLoss === null ? 'no SL' : `SL ${item.stopLoss}`} ·{' '}
                {item.takeProfit === null ? 'no TP' : `TP ${item.takeProfit}`}
              </Text>
            )}

            {cancelling === item.orderId ? (
              <View style={styles.confirm}>
                <Text style={styles.confirmText}>
                  Cancel this {item.type.toLowerCase()} order? It will stop waiting for {item.price}
                  .
                </Text>
                <Button
                  label="Cancel order"
                  variant="danger"
                  busy={busy}
                  onPress={() => void cancel(item)}
                />
                <Button label="Leave it" variant="quiet" onPress={() => setCancelling(null)} />
              </View>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Cancel ${item.symbol} ${item.type} order`}
                onPress={() => setCancelling(item.orderId)}
                style={styles.affordance}
              >
                <Text style={styles.affordanceLabel}>Cancel</Text>
              </Pressable>
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
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  symbol: { color: theme.colors.text, fontSize: 16, fontWeight: '600' },
  side: { fontSize: 13, fontFamily: theme.font.mono },
  detail: {
    color: theme.colors.textMuted,
    fontSize: 13,
    fontFamily: theme.font.mono,
    marginTop: theme.spacing(0.25),
  },
  affordance: {
    alignSelf: 'flex-start',
    marginTop: theme.spacing(1),
    paddingVertical: theme.spacing(0.75),
    paddingHorizontal: theme.spacing(1.5),
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceRaised,
    minHeight: 36,
    justifyContent: 'center',
  },
  affordanceLabel: { color: theme.colors.textMuted, fontSize: 13 },
  confirm: {
    marginTop: theme.spacing(1),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing(1),
  },
  confirmText: { color: theme.colors.text, fontSize: 14 },
});
