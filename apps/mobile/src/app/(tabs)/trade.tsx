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

  return (
    <View style={styles.screen}>
      <AccountPicker />
      {/* Three figures across, as a terminal shows them: what the account is
          worth, what the positions hold, what is left to trade with — each
          with the number that explains it underneath. */}
      <View style={styles.strip}>
        <View style={styles.tile}>
          <Text style={styles.label}>{t('account.equity')}</Text>
          <Text
            style={[styles.value, { writingDirection: NUMERIC_DIRECTION }]}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {state?.equity ?? '—'}
          </Text>
          <PnlText value={state?.floatingPnl ?? null} style={styles.sub} />
        </View>
        <View style={styles.tile}>
          <Text style={styles.label}>{t('account.margin')}</Text>
          <Text
            style={[styles.value, { writingDirection: NUMERIC_DIRECTION }]}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {state?.usedMargin ?? '—'}
          </Text>
          <Text style={styles.subMuted} numberOfLines={1}>
            {state === undefined || state.marginLevel === null ? '—' : `${state.marginLevel}%`}
          </Text>
        </View>
        <View style={styles.tile}>
          <Text style={styles.label}>{t('account.freeMargin')}</Text>
          <Text
            style={[styles.value, { writingDirection: NUMERIC_DIRECTION }]}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {state?.freeMargin ?? '—'}
          </Text>
          <Text style={styles.subMuted} numberOfLines={1}>
            {t('account.balance')} {state?.balance ?? selected?.balance ?? '—'}
          </Text>
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
  strip: {
    flexDirection: 'row',
    gap: theme.spacing(1),
    marginHorizontal: theme.spacing(2),
    marginTop: theme.spacing(1.5),
  },
  tile: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing(1.25),
    paddingVertical: theme.spacing(1),
  },
  label: {
    fontFamily: theme.font.medium,
    color: theme.colors.textMuted,
    fontSize: theme.type.caption,
  },
  value: {
    fontFamily: theme.font.monoBold,
    color: theme.colors.text,
    fontSize: theme.type.body,
    marginTop: 4,
  },
  sub: {
    fontFamily: theme.font.monoBold,
    fontSize: theme.type.caption,
    marginTop: 2,
    alignSelf: 'flex-start',
  },
  subMuted: {
    fontFamily: theme.font.mono,
    color: theme.colors.textFaint,
    fontSize: theme.type.caption,
    marginTop: 4,
  },
  switch: { marginHorizontal: theme.spacing(2), marginTop: theme.spacing(1.5) },
});
