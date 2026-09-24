import { AccountPicker } from '../../components/account-picker';
import { useAccounts } from '../../lib/accounts';
import { useLiveBook } from '../../lib/live';
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
import { DomainError } from '@tp/shared-types';
import { useSession } from '../../lib/session';
import { Button, Empty, ErrorNote, Screen } from '../../components/ui';
import { pendingOrderPatch } from '../../lib/protective-levels';
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
  // One account for the whole app, chosen by the trader rather than by the
  // order the server happened to list them in. See lib/accounts.tsx.
  const { selected: account } = useAccounts();
  // Moves when an order fills, is cancelled or is refused, and on reconnect.
  const { versions } = useLiveBook();
  const [orders, setOrders] = useState<PendingOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ price: '', volume: '', stopLoss: '', takeProfit: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      if (account === null) {
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
  }, [api, account]);

  useEffect(() => {
    void load();
  }, [load, versions.orders]);

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

  /**
   * Moves a resting order.
   *
   * The patch is built by `pendingOrderPatch`, which holds the two different
   * rules this form needs: an empty price means "leave it alone" because an
   * order without a price is not an order, while an empty stop loss means
   * "remove it".
   */
  const save = async (order: PendingOrder) => {
    const patch = pendingOrderPatch(form, {
      price: order.price,
      volume: order.volume,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
    });
    if (patch === null) {
      setEditing(null);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.patch(`/orders/${order.orderId}`, patch, {
        idempotencyKey: `modify:${order.orderId}:${JSON.stringify(patch)}`,
      });
      setEditing(null);
      await load();
    } catch (caught) {
      setError(caught instanceof DomainError ? caught.message : 'The order was not changed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <AccountPicker />
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
            ) : editing === item.orderId ? (
              <View style={styles.confirm}>
                <Field
                  label="Price"
                  value={form.price}
                  onChange={(value) => setForm((c) => ({ ...c, price: value }))}
                />
                <Field
                  label="Volume"
                  value={form.volume}
                  onChange={(value) => setForm((c) => ({ ...c, volume: value }))}
                />
                <Field
                  label="Stop loss"
                  value={form.stopLoss}
                  placeholder="empty to remove"
                  onChange={(value) => setForm((c) => ({ ...c, stopLoss: value }))}
                />
                <Field
                  label="Take profit"
                  value={form.takeProfit}
                  placeholder="empty to remove"
                  onChange={(value) => setForm((c) => ({ ...c, takeProfit: value }))}
                />
                <Button
                  label="Save changes"
                  busy={busy}
                  disabled={
                    pendingOrderPatch(form, {
                      price: item.price,
                      volume: item.volume,
                      stopLoss: item.stopLoss,
                      takeProfit: item.takeProfit,
                    }) === null
                  }
                  onPress={() => void save(item)}
                />
                <Button label="Cancel" variant="quiet" onPress={() => setEditing(null)} />
              </View>
            ) : (
              <View style={styles.actions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Change ${item.symbol} ${item.type} order`}
                  onPress={() => {
                    setForm({
                      price: item.price,
                      volume: item.volume,
                      stopLoss: item.stopLoss ?? '',
                      takeProfit: item.takeProfit ?? '',
                    });
                    setEditing(item.orderId);
                  }}
                  style={styles.affordance}
                >
                  <Text style={styles.affordanceLabel}>Change</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Cancel ${item.symbol} ${item.type} order`}
                  onPress={() => setCancelling(item.orderId)}
                  style={styles.affordance}
                >
                  <Text style={styles.affordanceLabel}>Cancel</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}
      />
    </Screen>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}): React.ReactElement {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        accessibilityLabel={label}
        placeholder={placeholder ?? ''}
        placeholderTextColor={theme.colors.textMuted}
      />
    </View>
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
  actions: { flexDirection: 'row', gap: theme.spacing(1) },
  field: { marginBottom: theme.spacing(1) },
  fieldLabel: { color: theme.colors.textMuted, fontSize: 12 },
  fieldInput: {
    backgroundColor: theme.colors.surfaceRaised,
    borderRadius: theme.radius.sm,
    color: theme.colors.text,
    fontFamily: theme.font.mono,
    fontSize: 15,
    minHeight: 44,
    paddingHorizontal: theme.spacing(1),
  },
});
