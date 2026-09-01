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
import { describePatch, protectivePatch } from '../../lib/protective-levels';
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
  /** Marked by the server. Null when no fresh price exists — never '0'. */
  floatingPnl: string | null;
  netFloatingPnl: string | null;
  stale: boolean | null;
  openedAt: string;
}

export default function Positions(): React.ReactElement {
  const { api } = useSession();
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** The position awaiting a second press. §43: closing is irreversible. */
  const [closing, setClosing] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ stopLoss: '', takeProfit: '' });
  const [busy, setBusy] = useState(false);

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

  /**
   * Closes a position, after it has been confirmed.
   *
   * The confirmation is not politeness. A close is irreversible, it realises
   * whatever the P&L happens to be at that instant, and a mistap on a phone in
   * a pocket is a real way to lose money. The confirmation row shows the
   * position and its current P&L, so the number being realised is on screen at
   * the moment the trader agrees to realise it.
   */
  const close = async (position: Position) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/positions/${position.id}/close`,
        {},
        { idempotencyKey: `close:${position.id}` },
      );
      setClosing(null);
      await load();
    } catch (caught) {
      setError(caught instanceof DomainError ? caught.message : 'The position was not closed.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Changes a position's protective levels.
   *
   * The patch is built by `protectivePatch`, which is the only place that knows
   * the difference between "clear this level" and "leave it alone" — a
   * distinction a text box cannot express and one that decides whether a trader
   * ends up protected when they think they are not.
   */
  const saveLevels = async (position: Position) => {
    const patch = protectivePatch(form, {
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
    });
    if (patch === null) {
      setEditing(null);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.patch(`/positions/${position.id}`, patch, {
        idempotencyKey: `levels:${position.id}:${JSON.stringify(patch)}`,
      });
      setEditing(null);
      await load();
    } catch (caught) {
      setError(caught instanceof DomainError ? caught.message : 'The levels were not changed.');
    } finally {
      setBusy(false);
    }
  };

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
              {/* An em-dash, not a zero. A trader cannot tell a genuine flat
                  from a missing price, and one of those is a reason to act. */}
              <Text
                style={[
                  styles.pnl,
                  {
                    color:
                      item.floatingPnl === null
                        ? theme.colors.textMuted
                        : signColor(item.floatingPnl),
                    writingDirection: NUMERIC_DIRECTION,
                  },
                ]}
              >
                {item.floatingPnl === null ? '—' : formatSigned(item.floatingPnl)}
              </Text>
            </View>
            {item.stale === true ? (
              <Text style={styles.staleNote}>No fresh price — this mark may be out of date.</Text>
            ) : null}
            {item.stopLoss === null && item.takeProfit === null ? null : (
              <Text style={styles.protection}>
                {item.stopLoss === null ? 'no SL' : `SL ${item.stopLoss}`} ·{' '}
                {item.takeProfit === null ? 'no TP' : `TP ${item.takeProfit}`}
              </Text>
            )}

            {closing === item.id ? (
              <View style={styles.confirm}>
                <Text style={styles.confirmText}>
                  Close {item.volume} {item.symbol} and realise{' '}
                  {item.netFloatingPnl === null
                    ? 'an unknown amount'
                    : formatSigned(item.netFloatingPnl)}
                  ?
                </Text>
                <Button
                  label="Close position"
                  variant="danger"
                  busy={busy}
                  onPress={() => void close(item)}
                />
                <Button label="Keep it open" variant="quiet" onPress={() => setClosing(null)} />
              </View>
            ) : editing === item.id ? (
              <View style={styles.confirm}>
                <LevelField
                  label="Stop loss"
                  value={form.stopLoss}
                  onChange={(value) => setForm((current) => ({ ...current, stopLoss: value }))}
                />
                <LevelField
                  label="Take profit"
                  value={form.takeProfit}
                  onChange={(value) => setForm((current) => ({ ...current, takeProfit: value }))}
                />
                {/* Says what will happen, in words. "Are you sure?" confirms
                    nothing, and removing a stop deserves a sentence that names
                    the consequence. */}
                <Text style={styles.confirmText}>
                  {describeChange(form, item) ?? 'Nothing has changed.'}
                </Text>
                <Button
                  label="Save levels"
                  busy={busy}
                  disabled={describeChange(form, item) === null}
                  onPress={() => void saveLevels(item)}
                />
                <Button label="Cancel" variant="quiet" onPress={() => setEditing(null)} />
              </View>
            ) : (
              <View style={styles.actions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Change stop loss and take profit for ${item.symbol}`}
                  onPress={() => {
                    setForm({
                      stopLoss: item.stopLoss ?? '',
                      takeProfit: item.takeProfit ?? '',
                    });
                    setEditing(item.id);
                  }}
                  style={styles.closeAffordance}
                >
                  <Text style={styles.closeLabel}>SL / TP</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Close ${item.symbol} position`}
                  onPress={() => setClosing(item.id)}
                  style={styles.closeAffordance}
                >
                  <Text style={styles.closeLabel}>Close</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}
      />
    </Screen>
  );
}

/** The sentence shown before saving, or null when nothing changed. */
function describeChange(
  form: { stopLoss: string; takeProfit: string },
  position: Position,
): string | null {
  const patch = protectivePatch(form, {
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
  });
  return patch === null ? null : `This will ${describePatch(patch)}.`;
}

function LevelField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): React.ReactElement {
  return (
    <View style={styles.levelField}>
      <Text style={styles.levelLabel}>{label}</Text>
      <TextInput
        style={styles.levelInput}
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        accessibilityLabel={label}
        placeholder="empty to remove"
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
  confirm: {
    marginTop: theme.spacing(1),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing(1),
  },
  confirmText: { color: theme.colors.text, fontSize: 14 },
  closeAffordance: {
    alignSelf: 'flex-start',
    marginTop: theme.spacing(1),
    paddingVertical: theme.spacing(0.75),
    paddingHorizontal: theme.spacing(1.5),
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceRaised,
    minHeight: 36,
    justifyContent: 'center',
  },
  closeLabel: { color: theme.colors.textMuted, fontSize: 13 },
  actions: { flexDirection: 'row', gap: theme.spacing(1) },
  staleNote: { color: theme.colors.warning, fontSize: 11, marginTop: theme.spacing(0.5) },
  levelField: { marginBottom: theme.spacing(1) },
  levelLabel: { color: theme.colors.textMuted, fontSize: 12 },
  levelInput: {
    backgroundColor: theme.colors.surfaceRaised,
    borderRadius: theme.radius.sm,
    color: theme.colors.text,
    fontFamily: theme.font.mono,
    fontSize: 15,
    minHeight: 44,
    paddingHorizontal: theme.spacing(1),
  },
});
