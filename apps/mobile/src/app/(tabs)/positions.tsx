import { useRouter } from 'expo-router';
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
import { useSession } from '../../lib/session';
import { useAccounts } from '../../lib/accounts';
import { useLiveBook } from '../../lib/live';
import { applyPnl } from '../../lib/live-book';
import { Button, Empty, ErrorNote, InstrumentBadge, Screen, SideTag } from '../../components/ui';
import { describePatch, protectionLine, protectivePatch } from '../../lib/protective-levels';
import {
  closeAllBody,
  closeAllKey,
  closeAllQuestion,
  closeAllReport,
  stillSelected,
  toggleSelected,
  type CloseAllOutcome,
  type CloseAllReport,
} from '../../lib/close-all';
import { PnlText } from '../../components/pnl-text';
import { formatSigned, theme } from '../../lib/theme';
import { useT } from '../../lib/i18n';
import { refusalText, type Translate } from '../../lib/messages';

interface Position {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: string;
  entryPrice: string;
  currentPrice: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  trailingStopDistance: string | null;
  /** Marked by the server. Null when no fresh price exists — never '0'. */
  floatingPnl: string | null;
  netFloatingPnl: string | null;
  stale: boolean | null;
  openedAt: string;
}

export default function Positions(): React.ReactElement {
  const t = useT();
  const { api } = useSession();
  const router = useRouter();
  // The account whose book this is — the one the trader chose, as on every tab.
  const { selected: account } = useAccounts();
  const live = useLiveBook();
  const [loaded, setPositions] = useState<Position[] | null>(null);
  /**
   * The rows REST returned, marked by the newest P&L frame. The list itself
   * — which positions exist — comes only from REST, refetched when a frame
   * says it changed; the figures on each row follow the server's valuation.
   */
  const positions = applyPnl(loaded, account === null ? undefined : live.pnl[account.id]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** The position awaiting a second press. §43: closing is irreversible. */
  const [closing, setClosing] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  /** The card opened to its actions; one at a time. */
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ stopLoss: '', takeProfit: '' });
  const [busy, setBusy] = useState(false);
  /**
   * The close-all question while it is on screen, with the key minted when it
   * was asked — so a second tap or a retry is the same command, and asking
   * again after cancelling is a new one. See `closeAllKey`.
   */
  const [closingAll, setClosingAll] = useState<{
    key: string;
    count: number;
    /** The ticked positions this question is about; `null` is the whole book. */
    positionIds: string[] | null;
  } | null>(null);
  const [allReport, setAllReport] = useState<CloseAllReport | null>(null);
  /** "Close (n)": ticked rows, counted only while they are still open. */
  const [ticked, setTicked] = useState<string[]>([]);
  const selected = stillSelected(ticked, positions ?? []);

  /**
   * The open book of the selected account.
   *
   * The server lists positions per account and refuses a request that does not
   * name one. This asked for `/positions` alone, was refused every time, and
   * the tab showed "Could not refresh positions" to everybody who opened it —
   * found by `pnpm smoke:contracts`, which makes each client call as written.
   */
  const load = useCallback(async () => {
    try {
      if (account === null) {
        setPositions([]);
        return;
      }
      setPositions(await api.get<Position[]>('/positions', { query: { accountId: account.id } }));
      setError(null);
    } catch {
      setError(t('positions.refreshFailed'));
    }
  }, [api, account, t]);

  useEffect(() => {
    void load();
  }, [load, live.versions.positions]);

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
      setError(refusalText(caught, 'positions.closeFailed', t));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Every open position on the account, as one server command.
   *
   * Not a loop of the single close above: the server states the intent once,
   * closes largest-margin first, and reports each position — including the
   * ones it could not close, and why — which is what the report says.
   */
  const closeAll = async () => {
    if (account === null || closingAll === null) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await api.post<CloseAllOutcome>(
        '/positions/close-all',
        closeAllBody(account.id, closingAll.positionIds),
        { idempotencyKey: closingAll.key },
      );
      setAllReport(closeAllReport(outcome, t));
      setClosingAll(null);
      setTicked([]);
      await load();
    } catch (caught) {
      setError(refusalText(caught, 'positions.closeAllFailed', t));
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
      setError(refusalText(caught, 'positions.levelsFailed', t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      {error === null ? null : <ErrorNote message={error} />}
      {allReport === null ? null : (
        <Pressable
          onPress={() => setAllReport(null)}
          accessibilityRole="button"
          accessibilityLabel={t('positions.dismissReport')}
          style={[styles.report, allReport.tone === 'partial' ? styles.reportPartial : null]}
        >
          <Text style={styles.confirmText}>{allReport.message}</Text>
          {allReport.stillOpen.map((one) => {
            const position = (positions ?? []).find((p) => p.id === one.positionId);
            return (
              <Text key={one.positionId} style={styles.detail}>
                {position === undefined
                  ? one.positionId.slice(0, 8)
                  : `${position.symbol} ${position.side} ${position.volume}`}
                {' — '}
                {one.reason}
              </Text>
            );
          })}
        </Pressable>
      )}
      {(positions ?? []).length < 2 ? null : closingAll === null ? (
        <View style={styles.bookBar}>
          <Text style={styles.detail}>
            {selected.length === 0
              ? t('positions.open', { n: (positions ?? []).length })
              : t('positions.selected', { n: selected.length, total: (positions ?? []).length })}
          </Text>
          {selected.length === 0 ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear the selection"
              style={styles.closeAffordance}
              onPress={() => setTicked([])}
            >
              <Text style={styles.closeLabel}>{t('positions.clear')}</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <View style={styles.confirm}>
          <Text style={styles.confirmText}>
            {closeAllQuestion(closingAll.count, closingAll.positionIds !== null, t)}
          </Text>
          <Button
            label={
              closingAll.positionIds === null
                ? t('positions.closeAllConfirm', { n: closingAll.count })
                : t('positions.closeSelectedConfirm', { n: closingAll.count })
            }
            variant="danger"
            busy={busy}
            onPress={() => void closeAll()}
          />
          <Button
            label={t('positions.keepThemOpen')}
            variant="quiet"
            onPress={() => setClosingAll(null)}
          />
        </View>
      )}
      <FlatList
        data={positions ?? []}
        contentContainerStyle={{ paddingBottom: 72 }}
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
          <Empty message={positions === null ? t('common.loading') : t('positions.none')} />
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            {/* TradeLocker's card: the instrument and what it is making on one
                line; side, size and the move on the next, the levels beside.
                A tap opens what can be done with it. */}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: open === item.id }}
              accessibilityLabel={`${item.symbol} ${item.side} ${item.volume}`}
              onPress={() => setOpen(open === item.id ? null : item.id)}
              style={({ pressed }) => [pressed ? { opacity: 0.75 } : null]}
            >
              <View style={styles.rowTop}>
                <InstrumentBadge code={item.symbol} size={22} />
                <Text style={styles.symbol}>{item.symbol}</Text>
                <View style={{ flex: 1 }} />
                <View
                  style={[
                    styles.pnlPill,
                    {
                      backgroundColor:
                        item.floatingPnl === null
                          ? theme.colors.surfaceRaised
                          : item.floatingPnl.startsWith('-')
                            ? theme.colors.sellTint
                            : theme.colors.profitTint,
                    },
                  ]}
                >
                  {/* An em-dash, not a zero: a missing price is not a flat. */}
                  <PnlText value={item.floatingPnl} style={styles.pnl} />
                </View>
                <Text style={styles.chevron}>{open === item.id ? '⌃' : '⌄'}</Text>
              </View>
              <View style={styles.rowBottom}>
                <SideTag
                  side={item.side}
                  label={t(item.side === 'BUY' ? 'common.BUY' : 'common.SELL')}
                />
                <Text style={styles.volume}>{item.volume}</Text>
                <Text style={styles.lotsWord}>{t('oneTap.lots')}</Text>
                <Text style={styles.detail} numberOfLines={1}>
                  {item.entryPrice} →{' '}
                </Text>
                <Text
                  style={[
                    styles.detail,
                    {
                      color:
                        item.floatingPnl === null
                          ? theme.colors.textMuted
                          : item.floatingPnl.startsWith('-')
                            ? theme.colors.negative
                            : theme.colors.profit,
                    },
                  ]}
                  numberOfLines={1}
                >
                  {item.currentPrice ?? '—'}
                </Text>
                <View style={{ flex: 1 }} />
                <Text
                  style={[
                    styles.levelChip,
                    item.stopLoss === null ? styles.levelOff : styles.levelSl,
                  ]}
                >
                  SL
                </Text>
                <Text
                  style={[
                    styles.levelChip,
                    item.takeProfit === null ? styles.levelOff : styles.levelTp,
                  ]}
                >
                  TP
                </Text>
              </View>
            </Pressable>
            {item.stale === true ? (
              <Text style={styles.staleNote}>{t('positions.stale')}</Text>
            ) : null}
            {open === item.id && protectionLine(item, t) !== null ? (
              <Text style={styles.protection}>{protectionLine(item, t)}</Text>
            ) : null}

            {closing === item.id ? (
              <View style={styles.confirm}>
                <Text style={styles.confirmText}>
                  {t('positions.closeQuestion', {
                    volume: item.volume,
                    symbol: item.symbol,
                    pnl:
                      item.netFloatingPnl === null
                        ? t('positions.unknownAmount')
                        : formatSigned(item.netFloatingPnl),
                  })}
                </Text>
                <Button
                  label={t('positions.closePosition')}
                  variant="danger"
                  busy={busy}
                  onPress={() => void close(item)}
                />
                <Button
                  label={t('positions.keepItOpen')}
                  variant="quiet"
                  onPress={() => setClosing(null)}
                />
              </View>
            ) : editing === item.id ? (
              <View style={styles.confirm}>
                <LevelField
                  label={t('positions.stopLoss')}
                  value={form.stopLoss}
                  onChange={(value) => setForm((current) => ({ ...current, stopLoss: value }))}
                />
                <LevelField
                  label={t('positions.takeProfit')}
                  value={form.takeProfit}
                  onChange={(value) => setForm((current) => ({ ...current, takeProfit: value }))}
                />
                {/* Says what will happen, in words. "Are you sure?" confirms
                    nothing, and removing a stop deserves a sentence that names
                    the consequence. */}
                <Text style={styles.confirmText}>
                  {describeChange(form, item, t) ?? t('positions.nothingChanged')}
                </Text>
                <Button
                  label={t('positions.saveLevels')}
                  busy={busy}
                  disabled={describeChange(form, item, t) === null}
                  onPress={() => void saveLevels(item)}
                />
                <Button
                  label={t('common.cancel')}
                  variant="quiet"
                  onPress={() => setEditing(null)}
                />
              </View>
            ) : open !== item.id ? null : (
              <View style={styles.actions}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => router.push(`/(tabs)/chart?symbol=${item.symbol}`)}
                  style={styles.closeAffordance}
                >
                  <Text style={styles.closeLabel}>{t('quotes.chart')}</Text>
                </Pressable>
                {(positions ?? []).length < 2 ? null : (
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected.includes(item.id) }}
                    accessibilityLabel={`Select ${item.symbol} ${item.side} ${item.volume}`}
                    onPress={() => setTicked((current) => toggleSelected(current, item.id))}
                    style={styles.closeAffordance}
                  >
                    <Text style={styles.closeLabel}>
                      {selected.includes(item.id)
                        ? `☑ ${t('positions.selectedMark')}`
                        : `☐ ${t('positions.select')}`}
                    </Text>
                  </Pressable>
                )}
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
                  <Text style={styles.closeLabel}>{t('positions.levels')}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Close ${item.symbol} position`}
                  onPress={() => setClosing(item.id)}
                  style={styles.closeAffordance}
                >
                  <Text style={styles.closeLabel}>{t('positions.close')}</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}
      />
      {(positions ?? []).length < 2 || closingAll !== null ? null : (
        <Pressable
          accessibilityRole="button"
          style={styles.closeAllFloat}
          onPress={() => {
            setAllReport(null);
            setClosingAll({
              key: closeAllKey(
                account?.id ?? 'none',
                Date.now(),
                Math.random().toString(36).slice(2),
              ),
              count: selected.length === 0 ? (positions ?? []).length : selected.length,
              positionIds: selected.length === 0 ? null : selected,
            });
          }}
        >
          <Text style={styles.closeAllLabel}>
            {selected.length === 0
              ? t('positions.closeAllCount', { n: (positions ?? []).length })
              : t('positions.closeCount', { n: selected.length })}
          </Text>
        </Pressable>
      )}
    </Screen>
  );
}

/** The sentence shown before saving, or null when nothing changed. */
function describeChange(
  form: { stopLoss: string; takeProfit: string },
  position: Position,
  t: Translate,
): string | null {
  const patch = protectivePatch(form, {
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
  });
  return patch === null ? null : t('positions.willDo', { change: describePatch(patch, t) });
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
  const t = useT();
  return (
    <View style={styles.levelField}>
      <Text style={styles.levelLabel}>{label}</Text>
      <TextInput
        style={styles.levelInput}
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        accessibilityLabel={label}
        placeholder={t('common.emptyToRemove')}
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
    paddingHorizontal: theme.spacing(1.5),
    paddingVertical: theme.spacing(1.25),
    marginBottom: theme.spacing(1),
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1) },
  pnlPill: { borderRadius: theme.radius.xs, paddingHorizontal: 8, paddingVertical: 2 },
  chevron: {
    fontFamily: theme.font.bold,
    color: theme.colors.textMuted,
    fontSize: theme.type.title,
    width: 16,
    textAlign: 'center',
  },
  volume: { fontFamily: theme.font.monoBold, color: theme.colors.text, fontSize: theme.type.small },
  lotsWord: {
    fontFamily: theme.font.regular,
    color: theme.colors.textMuted,
    fontSize: theme.type.caption,
  },
  levelChip: {
    fontFamily: theme.font.bold,
    fontSize: theme.type.caption,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  levelOff: { color: theme.colors.textFaint, backgroundColor: theme.colors.surfaceRaised },
  levelSl: { color: theme.colors.negative, backgroundColor: theme.colors.sellTint },
  levelTp: { color: theme.colors.profit, backgroundColor: theme.colors.profitTint },
  rowBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: theme.spacing(1),
  },
  symbol: { fontFamily: theme.font.heavy, color: theme.colors.text, fontSize: theme.type.body },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(0.75) },
  levels: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: theme.spacing(1) },
  side: { fontFamily: theme.font.mono, fontSize: theme.type.body },
  detail: {
    fontFamily: theme.font.mono,
    color: theme.colors.textMuted,
    fontSize: theme.type.small,
  },
  pnl: { fontFamily: theme.font.monoBold, fontSize: theme.type.small },
  protection: {
    fontFamily: theme.font.regular,
    color: theme.colors.textMuted,
    fontSize: theme.type.label,
    marginTop: theme.spacing(0.5),
  },
  confirm: {
    marginTop: theme.spacing(1),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing(1),
  },
  confirmText: {
    fontFamily: theme.font.regular,
    color: theme.colors.text,
    fontSize: theme.type.body,
  },
  bookBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing(2),
    paddingVertical: theme.spacing(1),
  },
  report: {
    gap: theme.spacing(0.5),
    padding: theme.spacing(2),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  reportPartial: { backgroundColor: theme.colors.surface },
  closeAffordance: {
    alignSelf: 'flex-start',
    marginTop: theme.spacing(1),
    paddingVertical: theme.spacing(0.75),
    paddingHorizontal: theme.spacing(1.5),
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceRaised,
    minHeight: theme.control.sm,
    justifyContent: 'center',
  },
  closeAllFloat: {
    position: 'absolute',
    bottom: theme.spacing(2),
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceRaised,
    borderWidth: 1,
    borderColor: theme.colors.borderStrong,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing(2),
    minHeight: theme.control.md,
    elevation: 6,
  },
  closeAllLabel: {
    fontFamily: theme.font.bold,
    color: theme.colors.text,
    fontSize: theme.type.body,
  },
  closeLabel: {
    fontFamily: theme.font.regular,
    color: theme.colors.textMuted,
    fontSize: theme.type.small,
  },
  actions: { flexDirection: 'row', gap: theme.spacing(1) },
  staleNote: {
    fontFamily: theme.font.regular,
    color: theme.colors.warning,
    fontSize: theme.type.caption,
    marginTop: theme.spacing(0.5),
  },
  levelField: { marginBottom: theme.spacing(1) },
  levelLabel: {
    fontFamily: theme.font.regular,
    color: theme.colors.textMuted,
    fontSize: theme.type.label,
  },
  levelInput: {
    fontFamily: theme.font.mono,
    backgroundColor: theme.colors.surfaceRaised,
    borderRadius: theme.radius.sm,
    color: theme.colors.text,
    fontSize: theme.type.body,
    minHeight: theme.control.md,
    paddingHorizontal: theme.spacing(1),
  },
});
