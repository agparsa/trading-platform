import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AccountPicker } from '../../components/account-picker';
import { Segmented } from '../../components/ui';
import { useAccounts } from '../../lib/accounts';
import { NUMERIC_DIRECTION } from '../../lib/direction';
import { useT } from '../../lib/i18n';
import { useLiveBook } from '../../lib/live';
import { applyAccount } from '../../lib/live-book';
import type { MessageKey } from '../../lib/messages';
import { useSession } from '../../lib/session';
import { formatSigned, signColor, theme } from '../../lib/theme';
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

  const figure = (label: MessageKey, value: string | undefined, signed = false) => (
    <View style={styles.cell} key={label}>
      <Text style={styles.label}>{t(label)}</Text>
      <Text
        style={[
          styles.value,
          { writingDirection: NUMERIC_DIRECTION },
          signed && value !== undefined ? { color: signColor(value) } : null,
        ]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value === undefined ? '—' : signed ? formatSigned(value) : value}
      </Text>
    </View>
  );

  return (
    <View style={styles.screen}>
      <AccountPicker />
      <View style={styles.strip}>
        {figure('account.balance', state?.balance ?? selected?.balance)}
        {figure('account.equity', state?.equity)}
        {figure('account.floating', state?.floatingPnl, true)}
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
  strip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: theme.spacing(2),
    marginTop: theme.spacing(1.5),
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing(1),
  },
  cell: {
    width: '33.33%',
    alignItems: 'flex-start',
    paddingHorizontal: theme.spacing(1.5),
    paddingVertical: theme.spacing(0.75),
  },
  label: { color: theme.colors.textMuted, fontSize: 11 },
  value: {
    color: theme.colors.text,
    fontSize: 15,
    fontFamily: theme.font.mono,
    fontWeight: '600',
    marginTop: 2,
  },
  switch: { marginHorizontal: theme.spacing(2), marginTop: theme.spacing(1.5) },
});
