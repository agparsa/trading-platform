import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AccountPicker } from '../../components/account-picker';
import { Segmented } from '../../components/ui';
import { PnlText } from '../../components/pnl-text';
import { useAccounts } from '../../lib/accounts';
import { NUMERIC_DIRECTION } from '../../lib/direction';
import { useT } from '../../lib/i18n';
import { useLiveBook } from '../../lib/live';
import { applyAccount } from '../../lib/live-book';
import type { MessageKey } from '../../lib/messages';
import { useSession } from '../../lib/session';
import { theme } from '../../lib/theme';
import Orders from './orders';
import Positions from './positions';

interface AccountState {
  accountId: string;
  currency: string;
  balance: string;
  equity: string;
  usedMargin: string;
  freeMargin: string;
  marginLevel: string | null;
  floatingPnl: string;
  updatedAt: number;
}

/**
 * What is open on the selected account, under the account's own figures —
 * the screen a trader keeps coming back to.
 *
 * The figures are the server's: the REST snapshot when the screen opens, then
 * each valuation the socket sends laid over it. Positions and orders are the
 * same screens they were as tabs, side by side behind one switch.
 */
export default function Trade(): React.ReactElement {
  const t = useT();
  const { api } = useSession();
  const { selected } = useAccounts();
  const live = useLiveBook();
  const [snapshot, setSnapshot] = useState<AccountState | undefined>(undefined);
  const [view, setView] = useState<'positions' | 'orders'>('positions');

  const load = useCallback(async () => {
    if (selected === null) return;
    try {
      setSnapshot(await api.get<AccountState>(`/accounts/${selected.id}/state`));
    } catch {
      // The strip keeps what it had; the lists below say their own failures.
    }
  }, [api, selected]);

  useEffect(() => {
    void load();
  }, [load, live.versions.account]);

  const state = applyAccount(
    snapshot?.accountId === selected?.id ? snapshot : undefined,
    selected === null ? undefined : live.accounts[selected.id],
  );

  const figure = (label: MessageKey, value: string | undefined) => (
    <View style={styles.cell} key={label}>
      <Text style={styles.label}>{t(label)}</Text>
      <Text
        style={[styles.value, { writingDirection: NUMERIC_DIRECTION }]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value === undefined ? '—' : value}
      </Text>
    </View>
  );

  /**
   * How much of equity the open positions hold as margin, as a bar. A share
   * for the eye only — the figures beside it are the server's, unrounded.
   */
  const usage = (() => {
    const used = Number(state?.usedMargin);
    const equity = Number(state?.equity);
    if (!Number.isFinite(used) || !Number.isFinite(equity) || equity <= 0) return 0;
    return Math.max(0, Math.min(1, used / equity));
  })();

  return (
    <View style={styles.screen}>
      <AccountPicker />
      <View style={styles.hero}>
        <View style={styles.heroTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.heroLabel}>
              {t('account.equity')}
              {selected === null ? '' : `  ·  #${selected.number}`}
            </Text>
            <Text
              style={[styles.heroValue, { writingDirection: NUMERIC_DIRECTION }]}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {state?.equity ?? '—'}
            </Text>
          </View>
          <View style={styles.pnlBox}>
            <Text style={styles.heroLabel}>{t('account.floating')}</Text>
            <PnlText value={state?.floatingPnl ?? null} style={styles.pnl} />
          </View>
        </View>
        <View style={styles.bar} accessibilityElementsHidden>
          <View
            style={[
              styles.barFill,
              {
                width: `${Math.round(usage * 100)}%`,
                backgroundColor:
                  usage > 0.8
                    ? theme.colors.negative
                    : usage > 0.5
                      ? theme.colors.warning
                      : theme.colors.accent,
              },
            ]}
          />
        </View>
        <View style={styles.grid}>
          {figure('account.balance', state?.balance ?? selected?.balance)}
          {figure('account.margin', state?.usedMargin)}
          {figure('account.freeMargin', state?.freeMargin)}
          {figure(
            'account.marginLevel',
            state === undefined
              ? undefined
              : state.marginLevel === null
                ? '—'
                : `${state.marginLevel}%`,
          )}
        </View>
      </View>
      <View style={styles.switch}>
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'positions', label: t('screen.positions') },
            { value: 'orders', label: t('screen.orders') },
          ]}
        />
      </View>
      <View style={{ flex: 1 }}>{view === 'positions' ? <Positions /> : <Orders />}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  hero: {
    marginHorizontal: theme.spacing(2),
    marginTop: theme.spacing(1.5),
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    padding: theme.spacing(2),
  },
  heroTop: { flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing(1) },
  heroLabel: {
    color: theme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  heroValue: {
    color: theme.colors.text,
    fontSize: 30,
    fontWeight: '800',
    fontFamily: theme.font.mono,
    marginTop: 4,
  },
  pnlBox: { alignItems: 'flex-end' },
  pnl: { fontSize: 20, fontWeight: '800', fontFamily: theme.font.mono, marginTop: 4 },
  bar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.surfaceSunken,
    marginTop: theme.spacing(1.75),
    overflow: 'hidden',
  },
  barFill: { height: 6, borderRadius: 3 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: theme.spacing(1) },
  cell: { width: '50%', paddingVertical: theme.spacing(0.75) },
  label: { color: theme.colors.textMuted, fontSize: 12 },
  value: {
    color: theme.colors.text,
    fontSize: 15,
    fontFamily: theme.font.mono,
    fontWeight: '700',
    marginTop: 2,
  },
  switch: { marginHorizontal: theme.spacing(2), marginTop: theme.spacing(1.5) },
});
